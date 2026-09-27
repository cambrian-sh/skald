#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include "safe-file-native-support.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static napi_value open_directory(napi_env env, napi_callback_info info) {
  napi_value argument[1];
  char *path = NULL;
  if (!skald_read_arguments(env, info, 1, argument) || !skald_read_string(env, argument[0], &path)) return NULL;
  int descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int error = errno;
  free(path);
  if (descriptor < 0) return skald_throw_system_error(env, error, "open directory");
  return skald_number_value(env, descriptor);
}

static napi_value open_directory_at(napi_env env, napi_callback_info info) {
  napi_value argument[2];
  int32_t parent;
  char *name = NULL;
  if (!skald_read_arguments(env, info, 2, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &name)) {
    free(name);
    return NULL;
  }
  if (!skald_validate_component(env, name)) {
    free(name);
    return NULL;
  }
  int descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int error = errno;
  if (descriptor < 0 && error == ENOTDIR) {
    struct stat status;
    if (fstatat(parent, name, &status, AT_SYMLINK_NOFOLLOW) == 0 && S_ISLNK(status.st_mode)) {
      error = ELOOP;
    }
  }
  free(name);
  if (descriptor < 0) return skald_throw_system_error(env, error, "open directory child");
  return skald_number_value(env, descriptor);
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value argument[3];
  int32_t parent;
  int32_t mode;
  char *name = NULL;
  if (!skald_read_arguments(env, info, 3, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &name) || !skald_read_int32(env, argument[2], &mode)) {
    free(name);
    return NULL;
  }
  if (!skald_validate_component(env, name)) {
    free(name);
    return NULL;
  }
  int result = mkdirat(parent, name, (mode_t)mode);
  int error = errno;
  free(name);
  if (result != 0) return skald_throw_system_error(env, error, "create directory child");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value open_file_at(napi_env env, napi_callback_info info) {
  napi_value argument[4];
  int32_t parent;
  int32_t flags;
  int32_t mode;
  char *name = NULL;
  if (!skald_read_arguments(env, info, 4, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &name) || !skald_read_int32(env, argument[2], &flags) ||
      !skald_read_int32(env, argument[3], &mode)) {
    free(name);
    return NULL;
  }
  if (!skald_validate_component(env, name)) {
    free(name);
    return NULL;
  }
  int descriptor = openat(parent, name, flags | O_NOFOLLOW | O_CLOEXEC, (mode_t)mode);
  int error = errno;
  free(name);
  if (descriptor < 0) return skald_throw_system_error(env, error, "open file child");
  return skald_number_value(env, descriptor);
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value argument[2];
  int32_t parent;
  char *name = NULL;
  if (!skald_read_arguments(env, info, 2, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &name)) {
    free(name);
    return NULL;
  }
  if (!skald_validate_component(env, name)) {
    free(name);
    return NULL;
  }
  struct stat status;
  int result = fstatat(parent, name, &status, AT_SYMLINK_NOFOLLOW);
  int error = errno;
  free(name);
  if (result != 0) return skald_throw_system_error(env, error, "stat file child");

  napi_value object;
  if (napi_create_object(env, &object) != napi_ok ||
      !skald_set_number(env, object, "dev", (double)status.st_dev) ||
      !skald_set_number(env, object, "ino", (double)status.st_ino) ||
      !skald_set_number(env, object, "mode", (double)status.st_mode) ||
      !skald_set_number(env, object, "size", (double)status.st_size) ||
      !skald_set_boolean(env, object, "isFile", S_ISREG(status.st_mode)) ||
      !skald_set_boolean(env, object, "isSymlink", S_ISLNK(status.st_mode))) {
    napi_throw_error(env, NULL, "Could not create filesystem metadata");
    return NULL;
  }
  return object;
}

static napi_value link_at(napi_env env, napi_callback_info info) {
  napi_value argument[3];
  int32_t parent;
  char *source = NULL;
  char *target = NULL;
  if (!skald_read_arguments(env, info, 3, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &source) || !skald_read_string(env, argument[2], &target)) {
    free(source);
    free(target);
    return NULL;
  }
  if (!skald_validate_component(env, source) || !skald_validate_component(env, target)) {
    free(source);
    free(target);
    return NULL;
  }
  int result = linkat(parent, source, parent, target, 0);
  int error = errno;
  free(source);
  free(target);
  if (result != 0) return skald_throw_system_error(env, error, "link file child");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value argument[3];
  int32_t parent;
  char *source = NULL;
  char *target = NULL;
  if (!skald_read_arguments(env, info, 3, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &source) || !skald_read_string(env, argument[2], &target)) {
    free(source);
    free(target);
    return NULL;
  }
  if (!skald_validate_component(env, source) || !skald_validate_component(env, target)) {
    free(source);
    free(target);
    return NULL;
  }
  int result = renameat(parent, source, parent, target);
  int error = errno;
  free(source);
  free(target);
  if (result != 0) return skald_throw_system_error(env, error, "rename file child");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value argument[2];
  int32_t parent;
  char *name = NULL;
  if (!skald_read_arguments(env, info, 2, argument) || !skald_read_int32(env, argument[0], &parent) ||
      !skald_read_string(env, argument[1], &name)) {
    free(name);
    return NULL;
  }
  if (!skald_validate_component(env, name)) {
    free(name);
    return NULL;
  }
  int result = unlinkat(parent, name, 0);
  int error = errno;
  free(name);
  if (result != 0) return skald_throw_system_error(env, error, "unlink file child");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value close_descriptor(napi_env env, napi_callback_info info) {
  napi_value argument[1];
  int32_t descriptor;
  if (!skald_read_arguments(env, info, 1, argument) || !skald_read_int32(env, argument[0], &descriptor)) return NULL;
  if (close(descriptor) != 0) return skald_throw_system_error(env, errno, "close descriptor");
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"openDirectory", NULL, open_directory, NULL, NULL, NULL, napi_default, NULL},
      {"openDirectoryAt", NULL, open_directory_at, NULL, NULL, NULL, napi_default, NULL},
      {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
      {"openFileAt", NULL, open_file_at, NULL, NULL, NULL, napi_default, NULL},
      {"statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL},
      {"linkAt", NULL, link_at, NULL, NULL, NULL, napi_default, NULL},
      {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
      {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
      {"close", NULL, close_descriptor, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) !=
      napi_ok) {
    napi_throw_error(env, NULL, "Could not register filesystem operations");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
