#ifndef SKALD_SAFE_FILE_NATIVE_SUPPORT_H
#define SKALD_SAFE_FILE_NATIVE_SUPPORT_H

#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>

napi_value skald_throw_type(napi_env env, const char *message);
napi_value skald_throw_system_error(napi_env env, int error, const char *path);
bool skald_read_string(napi_env env, napi_value value, char **result);
bool skald_read_int32(napi_env env, napi_value value, int32_t *result);
bool skald_read_arguments(napi_env env, napi_callback_info info, size_t expected,
                          napi_value *arguments);
bool skald_validate_component(napi_env env, const char *name);
napi_value skald_number_value(napi_env env, int32_t number);
bool skald_set_number(napi_env env, napi_value object, const char *name, double number);
bool skald_set_boolean(napi_env env, napi_value object, const char *name, bool boolean);

#endif
