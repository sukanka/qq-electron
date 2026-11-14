#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdatomic.h>
#include <stdlib.h>

#define EXPORT __attribute__((visibility("default")))

typedef void (*register_module_fn)(void *module);
typedef int (*add_cleanup_hook_fn)(void *isolate, void (*hook)(void *),
                                   void *arg);

static void forward_registration(const char *symbol, void *module) {
  register_module_fn register_module =
      (register_module_fn)dlsym(RTLD_DEFAULT, symbol);

  if (register_module == NULL)
    abort();

  register_module(module);
}

/* Tencent's Electron exports these aliases; upstream Electron does not. */
EXPORT
void qq_magic_napi_register(void *module) {
  forward_registration("napi_module_register", module);
}

EXPORT
void qq_magic_node_register(void *module) {
  forward_registration("node_module_register", module);
}

static atomic_int environment_stopping;
static atomic_int stopping_watch_registered;

static void mark_environment_stopping(void *argument) {
  (void)argument;
  atomic_store(&environment_stopping, 1);
}

/*
 * Tencent's Electron also exports node::IsEnvironmentStopping(v8::Isolate*),
 * which QQ's wrapper.node consults to skip work while the environment is
 * winding down. A missing isolate, context or environment counts as
 * stopping. node::Environment's own flag is private, so watch for the
 * public cleanup callback instead: node runs it while tearing the
 * environment down. Registration fails when the isolate has no
 * environment, which matches the "stopping" answer of the original.
 */
EXPORT
int _ZN4node21IsEnvironmentStoppingEPN2v87IsolateE(void *isolate) {
  static add_cleanup_hook_fn add_cleanup_hook;

  if (isolate == NULL)
    return 1;

  if (add_cleanup_hook == NULL) {
    add_cleanup_hook = (add_cleanup_hook_fn)dlsym(
        RTLD_DEFAULT,
        "_ZN4node25AddEnvironmentCleanupHookEPN2v87IsolateEPFvPvES3_");
    if (add_cleanup_hook == NULL)
      return 0;
  }

  if (!atomic_load(&stopping_watch_registered)) {
    if (!add_cleanup_hook(isolate, mark_environment_stopping, NULL))
      return 1;
    atomic_store(&stopping_watch_registered, 1);
  }

  return atomic_load(&environment_stopping);
}
