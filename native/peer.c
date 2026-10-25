/* No privilege elevation, command dispatch, SQL or user-controlled executable paths.
 * One bounded request per connection. OS credentials travel only over supervisor pipes. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/file.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/un.h>
#ifdef __APPLE__
#include <sys/acl.h>
#endif
#include <poll.h>
#include <time.h>
#ifdef __linux__
#include <sys/xattr.h>
#endif
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define REQUEST 131072
#define RESPONSE 1048576
static char input[REQUEST+1], output[RESPONSE+1];
static int peer(int fd, uid_t *uid, gid_t *gid) {
#if defined(__APPLE__)
 if(getpeereid(fd,uid,gid)||*uid==(uid_t)-1||*gid==(gid_t)-1)return -1;return 0;
#elif defined(__linux__)
 struct ucred c; socklen_t n=sizeof(c);
 if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&c,&n)||n!=sizeof(c)) return -1;
 *uid=c.uid; *gid=c.gid; return 0;
#else
 (void)fd;(void)uid;(void)gid; errno=ENOTSUP; return -1;
#endif
}
static int timeout_ms=3000;
static long milliseconds(void) {struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return -1;return t.tv_sec*1000L+t.tv_nsec/1000000L;}
static int line(int fd,char *buf,size_t cap) {
 size_t n=0;long deadline=milliseconds()+timeout_ms;
 while(n<cap) {long remaining=deadline-milliseconds();if(remaining<=0)return -1;
  struct pollfd p={fd,POLLIN,0};int ready=poll(&p,1,(int)remaining);if(ready<0&&errno==EINTR)continue;if(ready<=0)return -1;
  char c; ssize_t r=read(fd,&c,1);if(r<0&&errno==EINTR)continue;if(r!=1)return -1;
  if(c=='\n'){buf[n]=0;return (int)n;}buf[n++]=c;
 }return -1;
}
static int sendall(int fd,const char *b,size_t n) {
 while(n) {ssize_t r=write(fd,b,n);if(r<0&&errno==EINTR)continue;if(r<=0)return -1;b+=r;n-=(size_t)r;}return 0;
}
static int address(struct sockaddr_un *a,const char *path) {
 if(path[0]!='/'||strlen(path)>=sizeof(a->sun_path))return -1;
 memset(a,0,sizeof(*a));a->sun_family=AF_UNIX;strcpy(a->sun_path,path);return 0;
}
static int check(const char *path) {
 struct stat s;if(lstat(path,&s)||S_ISLNK(s.st_mode))return -1;
#ifdef __APPLE__
 /* Darwin reports ENOENT for an absent extended ACL. Any returned ACL is rejected.
  * Re-stat to distinguish absence of the ACL from disappearance/replacement of the file. */
 errno=0;acl_t a=acl_get_file(path,ACL_TYPE_EXTENDED);
 if(a){acl_free(a);return -1;}
 if(errno!=ENOENT)return -1;
 struct stat again;if(lstat(path,&again)||again.st_dev!=s.st_dev||again.st_ino!=s.st_ino)return -1;
#elif defined(__linux__)
 if(getxattr(path,"system.posix_acl_access",NULL,0)>=0||errno!=ENODATA)return -1;
#else
 return -1;
#endif
 return 0;
}
int main(int argc,char **argv) {
#ifndef __APPLE__
 (void)argc;(void)argv;fprintf(stderr,"PROTECTED_PLATFORM_UNSUPPORTED\n");return 2;
#endif
 signal(SIGPIPE,SIG_IGN);
 if(argc==2&&!strcmp(argv[1],"selftest-invalid")) {
  uid_t u;gid_t g;return peer(-1,&u,&g)==-1?0:1;
 }
 if(argc==2&&!strcmp(argv[1],"selftest")) {
  int s[2];uid_t u;gid_t g;if(socketpair(AF_UNIX,SOCK_STREAM,0,s)||peer(s[0],&u,&g))return 1;
  printf("{\"uid\":%u,\"gid\":%u}\n",(unsigned)u,(unsigned)g);return 0;
 }
 if(argc==2&&!strcmp(argv[1],"check")) {
  while(fgets(input,sizeof(input),stdin)) {size_t n=strlen(input);if(!n||input[n-1]!='\n')return 1;
   input[n-1]=0;if(check(input))return 1;}return ferror(stdin)?1:0;
 }
 if(argc<3)return 1;
 struct sockaddr_un a;if(address(&a,argv[2]))return 1;
 if(!strcmp(argv[1],"request")&&argc==4) {
  char *end;unsigned long expected=strtoul(argv[3],&end,10);if(!*argv[3]||*end)return 1;
  int fd=socket(AF_UNIX,SOCK_STREAM,0);uid_t u;gid_t g;timeout_ms=20000;
  if(fd<0||connect(fd,(struct sockaddr*)&a,sizeof(a))||peer(fd,&u,&g)||u!=expected)return 1;
  int n=line(0,input,REQUEST);if(n<0||sendall(fd,input,(size_t)n)||sendall(fd,"\n",1))return 1;
  n=line(fd,output,RESPONSE);if(n<0||sendall(1,output,(size_t)n)||sendall(1,"\n",1))return 1;return 0;
 }
 if(strcmp(argv[1],"listen")||(argc!=3&&argc!=4))return 1;
 mode_t socket_mode=0666;
 if(argc==4){if(!strcmp(argv[3],"0660"))socket_mode=0660;else if(strcmp(argv[3],"0666"))return 1;}
 char parent[sizeof(a.sun_path)];strcpy(parent,argv[2]);char *slash=strrchr(parent,'/');
 if(!slash)return 1;if(slash==parent)slash[1]=0;else *slash=0;
 struct stat directory;if(lstat(parent,&directory)||!S_ISDIR(directory.st_mode)||
   (directory.st_uid!=0&&directory.st_uid!=geteuid())||(directory.st_mode&0022)||check(parent))return 1;
 char lockpath[sizeof(a.sun_path)+8];snprintf(lockpath,sizeof(lockpath),"%s.lock",argv[2]);
 umask(0077);int lock=open(lockpath,O_RDWR|O_CREAT|O_NOFOLLOW,0600);struct stat locked;
 if(lock<0||fstat(lock,&locked)||!S_ISREG(locked.st_mode)||locked.st_uid!=geteuid()||locked.st_nlink!=1||(locked.st_mode&0077)||check(lockpath)||flock(lock,LOCK_EX|LOCK_NB))return 1;
 struct stat old;
 if(!lstat(argv[2],&old)){
  if(!S_ISSOCK(old.st_mode)||old.st_uid!=geteuid()||old.st_nlink!=1)return 1;
  int probe=socket(AF_UNIX,SOCK_STREAM,0);if(probe<0)return 1;
  if(fcntl(probe,F_SETFL,O_NONBLOCK)<0)return 1;
  int connected=connect(probe,(struct sockaddr*)&a,sizeof(a));int failure=errno;close(probe);
  if(connected==0||failure!=ECONNREFUSED)return 1;
  struct stat fresh;if(lstat(argv[2],&fresh)||fresh.st_dev!=old.st_dev||fresh.st_ino!=old.st_ino||unlink(argv[2]))return 1;
 }else if(errno!=ENOENT)return 1;
 int listener=socket(AF_UNIX,SOCK_STREAM,0);
 if(listener<0||bind(listener,(struct sockaddr*)&a,sizeof(a))||chown(argv[2],(uid_t)-1,directory.st_gid)||chmod(argv[2],socket_mode)||listen(listener,16)){fprintf(stderr,"BROKER_SOCKET_START_FAILED errno=%d\n",errno);return 1;}
 puts("{\"ready\":true}");fflush(stdout);
 for(;;) {
  struct pollfd waiting[2]={{listener,POLLIN,0},{0,POLLIN,0}};
  if(poll(waiting,2,-1)<0){if(errno==EINTR)continue;return 1;}
  if(waiting[1].revents)return 0;
  int fd=accept(listener,NULL,NULL);if(fd<0){if(errno==EINTR)continue;return 1;}
  struct timeval send_timeout={3,0};
  if(setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&send_timeout,sizeof(send_timeout))){close(fd);continue;}
  uid_t u;gid_t g;timeout_ms=3000;
  if(peer(fd,&u,&g)) {close(fd);continue;}
  int n=line(fd,input,REQUEST);if(n<0){close(fd);continue;}
  printf("{\"uid\":%u,\"gid\":%u,\"hex\":\"",(unsigned)u,(unsigned)g);
  for(int i=0;i<n;i++)printf("%02x",(unsigned char)input[i]);puts("\"}");fflush(stdout);
  timeout_ms=20000;n=line(0,output,RESPONSE);if(n<0)return 1;
  (void)sendall(fd,output,(size_t)n);(void)sendall(fd,"\n",1);close(fd);
 }
}
