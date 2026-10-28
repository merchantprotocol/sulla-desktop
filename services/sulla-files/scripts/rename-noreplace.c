// SPDX-License-Identifier: GPL-2.0-or-later
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#define RENAME_NOREPLACE (1u << 0)

/* The service passes already pinned parent directory descriptors as fd 3/4.
 * No host path, recursive operation, overwrite mode, or shell is accepted. */
static int component(const char *value) {
  return value[0] && strcmp(value, ".") && strcmp(value, "..") && !strchr(value, '/');
}

int main(int argc, char **argv) {
  struct stat from, to;
  if (argc != 3 || !component(argv[1]) || !component(argv[2]) ||
      fstat(3, &from) || fstat(4, &to) || !S_ISDIR(from.st_mode) || !S_ISDIR(to.st_mode)) return 64;
  if (syscall(SYS_renameat2, 3, argv[1], 4, argv[2], RENAME_NOREPLACE)) {
    /* Only errno crosses the helper boundary, never a sensitive pathname. */
    fprintf(stderr, "%d\n", errno);
    return 1;
  }
  if (fsync(4) || fsync(3)) { fprintf(stderr, "%d\n", errno); return 2; }
  return 0;
}
