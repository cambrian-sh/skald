#include "safe-file-native-support.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

napi_value skald_throw_type(napi_env env, const char *message) {
  napi_throw_type_error(env, NULL, message);
  return NULL;
}

static const char *error_code(int error) {
  switch (error) {
  case EACCES: return "EACCES";
  case EEXIST: return "EEXIST";
  case EINVAL: return "EINVAL";
  case EIO: return "EIO";
  case EISDIR: return "EISDIR";
  case ELOOP: return "ELOOP";
  case EMFILE: return "EMFILE";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case ENFILE: return "ENFILE";
  case ENOENT: return "ENOENT";
  case ENOSPC: return "ENOSPC";
  case ENOTDIR: return "ENOTDIR";
  case EPERM: return "EPERM";
  case EROFS: return "EROFS";
  case EXDEV: return "EXDEV";
  default: return "UNKNOWN";
  }
}

napi_value skald_throw_system_error(napi_env env, int error, const char *path) {
  char message[512];
  snprintf(message, sizeof(message), "%s: %s", path, strerror(error));
  napi_value text;
  napi_value value;
  napi_value code;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, NULL, text, &value) != napi_ok ||
      napi_create_string_utf8(env, error_code(error), NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_set_named_property(env, value, "code", code) != napi_ok) {
    napi_throw_error(env, NULL, "Could not construct filesystem error");
    return NULL;
  }
  napi_throw(env, value);
  return NULL;
}

bool skald_read_string(napi_env env, napi_value value, char **result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    skald_throw_type(env, "Filesystem path arguments must be strings");
    return false;
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_error(env, NULL, "Could not read filesystem path");
    return false;
  }
  char *buffer = malloc(length + 1);
  if (buffer == NULL) {
    napi_throw_error(env, NULL, "Out of memory reading filesystem path");
    return false;
  }
  size_t bytes_written = 0;
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &bytes_written) != napi_ok) {
    free(buffer);
    napi_throw_error(env, NULL, "Could not read filesystem path");
    return false;
  }
  if (memchr(buffer, '\0', bytes_written) != NULL) {
    free(buffer);
    skald_throw_type(env, "Filesystem path arguments must not contain NUL bytes");
    return false;
  }
  *result = buffer;
  return true;
}

bool skald_read_int32(napi_env env, napi_value value, int32_t *result) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    skald_throw_type(env, "Filesystem descriptor and flag arguments must be numbers");
    return false;
  }
  if (napi_get_value_int32(env, value, result) != napi_ok) {
    napi_throw_range_error(env, NULL, "Filesystem numeric argument is out of range");
    return false;
  }
  return true;
}

bool skald_read_arguments(napi_env env, napi_callback_info info, size_t expected,
                           napi_value *arguments) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, arguments, NULL, NULL) != napi_ok || count != expected) {
    napi_throw_type_error(env, NULL, "Invalid number of filesystem arguments");
    return false;
  }
  return true;
}

bool skald_validate_component(napi_env env, const char *name) {
  if (name[0] == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0 ||
      strchr(name, '/') != NULL) {
    skald_throw_type(env, "Filesystem child names must be single path components");
    return false;
  }
  return true;
}

napi_value skald_number_value(napi_env env, int32_t number) {
  napi_value result;
  if (napi_create_int32(env, number, &result) != napi_ok) {
    napi_throw_error(env, NULL, "Could not create filesystem descriptor");
    return NULL;
  }
  return result;
}

bool skald_set_number(napi_env env, napi_value object, const char *name, double number) {
  napi_value value;
  return napi_create_double(env, number, &value) == napi_ok &&
         napi_set_named_property(env, object, name, value) == napi_ok;
}

bool skald_set_boolean(napi_env env, napi_value object, const char *name, bool boolean) {
  napi_value value;
  return napi_get_boolean(env, boolean, &value) == napi_ok &&
         napi_set_named_property(env, object, name, value) == napi_ok;
}
