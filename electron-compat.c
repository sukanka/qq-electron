#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdlib.h>

typedef void (*register_module_fn)(void *module);

static void forward_registration(const char *symbol, void *module)
{
	register_module_fn register_module =
		(register_module_fn)dlsym(RTLD_DEFAULT, symbol);

	if (register_module == NULL)
		abort();

	register_module(module);
}

/* Tencent's Electron exports these aliases; upstream Electron does not. */
__attribute__((visibility("default")))
void qq_magic_napi_register(void *module)
{
	forward_registration("napi_module_register", module);
}

__attribute__((visibility("default")))
void qq_magic_node_register(void *module)
{
	forward_registration("node_module_register", module);
}
