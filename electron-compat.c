#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdarg.h>
#include <stdlib.h>

#include <glib.h>
#include <glib-object.h>
#include <vips/vips.h>

#define EXPORT __attribute__((visibility("default")))

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
EXPORT
void qq_magic_napi_register(void *module)
{
	forward_registration("napi_module_register", module);
}

EXPORT
void qq_magic_node_register(void *module)
{
	forward_registration("node_module_register", module);
}

/* sharp expects these wrappers from Tencent's bundled libvips. */
EXPORT
void vips_g_assert(gboolean condition)
{
	(void)condition;
}

EXPORT
gpointer vips_g_malloc(gsize size)
{
	return g_malloc(size);
}

EXPORT
void vips_g_free(gpointer memory)
{
	g_free(memory);
}

EXPORT
gpointer vips_g_object_ref(gpointer object)
{
	return g_object_ref(object);
}

EXPORT
void vips_g_object_unref(gpointer object)
{
	g_object_unref(object);
}

EXPORT
gulong vips_g_signal_connect(
	gpointer instance,
	const gchar *detailed_signal,
	GCallback handler,
	gpointer data)
{
	return g_signal_connect_data(
		instance,
		detailed_signal,
		handler,
		data,
		NULL,
		(GConnectFlags)0);
}

EXPORT
guint vips_g_log_set_handler(
	const gchar *domain,
	GLogLevelFlags levels,
	GLogFunc handler,
	gpointer data)
{
	return g_log_set_handler(domain, levels, handler, data);
}

EXPORT
gpointer vips_g_once(GOnce *once, GThreadFunc function, gpointer data)
{
	return g_once(once, function, data);
}

EXPORT
gboolean vips_g_atomic_int_dec_and_test(volatile gint *value)
{
	return g_atomic_int_dec_and_test(value);
}

EXPORT
void vips_g_atomic_int_inc(volatile gint *value)
{
	g_atomic_int_inc(value);
}

EXPORT
gint vips_g_snprintf(gchar *buffer, gulong size, const gchar *format, ...)
{
	va_list arguments;
	gint result;

	va_start(arguments, format);
	result = g_vsnprintf(buffer, size, format, arguments);
	va_end(arguments);

	return result;
}

EXPORT
gboolean vips_is_object(gpointer object)
{
	return VIPS_IS_OBJECT(object);
}
