#define _GNU_SOURCE
#define NAPI_VERSION 8

#include <node_api.h>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

#ifndef QQ_PORTAL_TIMEOUT_MS
#define QQ_PORTAL_TIMEOUT_MS 120000
#endif

#define PORTAL_NAME "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define OPEN_INTERFACE "org.freedesktop.portal.OpenURI"
#define REQUEST_INTERFACE "org.freedesktop.portal.Request"
#define REQUEST_PREFIX PORTAL_PATH "/request/"

typedef struct Bridge Bridge;
typedef struct Request Request;

struct Bridge {
  napi_threadsafe_function results;
  GMainContext *context;
  GMainLoop *loop;
  GThread *thread;
  GList *requests;              /* Accessed only by the GLib thread. */
  guint64 sequence;
  gboolean stopping;
  unsigned active_js;          /* Accessed only by the JavaScript thread. */
};

struct Request {
  Bridge *bridge;
  napi_deferred deferred;
  char *uri;
  char *address;
  char *path;
  const char *code;
  const char *message;
  GDBusConnection *bus;
  GCancellable *cancel;
  GSource *timeout;
  GHashTable *early_responses;
  guint subscription;
  gulong closed_handler;
  unsigned pending;
  gboolean replied;
  gboolean done;
};

static void complete_if_ready(Request *request);

static void request_free(Request *request)
{
  g_free(request->uri);
  g_free(request->address);
  g_free(request->path);
  g_free(request);
}

static void close_returned(GObject *object, GAsyncResult *result, gpointer data)
{
  Request *request = data;
  GVariant *reply = g_dbus_connection_call_finish(G_DBUS_CONNECTION(object), result, NULL);
  g_clear_pointer(&reply, g_variant_unref);
  request->pending--;
  complete_if_ready(request);
}

static void finish(Request *request, const char *code, const char *message, gboolean close_request)
{
  if (request->done) return;
  request->done = TRUE;
  request->code = code;
  request->message = message;
  g_cancellable_cancel(request->cancel);
  if (close_request && request->bus && request->path &&
      !g_dbus_connection_is_closed(request->bus)) {
    /* Let Close reach the portal before closing our dedicated connection. */
    request->pending++;
    g_dbus_connection_call(request->bus, PORTAL_NAME, request->path,
                          REQUEST_INTERFACE, "Close", NULL, NULL,
                          G_DBUS_CALL_FLAGS_NONE, 1000, NULL, close_returned, request);
  }
  complete_if_ready(request);
}

static void complete_if_ready(Request *request)
{
  Bridge *bridge = request->bridge;
  if (!request->done || request->pending) return;
  if (request->timeout) {
    g_source_destroy(request->timeout);
    g_source_unref(request->timeout);
  }
  if (request->bus) {
    if (request->subscription)
      g_dbus_connection_signal_unsubscribe(request->bus, request->subscription);
    if (request->closed_handler)
      g_signal_handler_disconnect(request->bus, request->closed_handler);
    g_dbus_connection_close(request->bus, NULL, NULL, NULL);
    g_object_unref(request->bus);
  }
  g_clear_object(&request->cancel);
  g_clear_pointer(&request->early_responses, g_hash_table_unref);
  bridge->requests = g_list_remove(bridge->requests, request);
  if (bridge->stopping ||
      napi_call_threadsafe_function(bridge->results, request, napi_tsfn_nonblocking) != napi_ok)
    request_free(request);
  if (bridge->stopping && bridge->requests == NULL)
    g_main_loop_quit(bridge->loop);
}

static void fail_dbus(Request *request, const GError *error, gboolean connecting)
{
  if (request->done) {
    complete_if_ready(request);
    return;
  }
  if (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_TIMED_OUT) ||
      g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_TIMEOUT) ||
      g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NO_REPLY) ||
      g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_TIMED_OUT)) {
    finish(request, "ERR_PORTAL_TIMEOUT", "The desktop portal request timed out", TRUE);
  } else if (connecting ||
             g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CLOSED) ||
             g_error_matches(error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_DISCONNECTED) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NOT_SUPPORTED) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_SERVICE_UNKNOWN) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NAME_HAS_NO_OWNER) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_METHOD) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_INTERFACE) ||
             g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_OBJECT)) {
    finish(request, "ERR_PORTAL_UNAVAILABLE", "The desktop portal is unavailable", FALSE);
  } else {
    finish(request, "ERR_PORTAL_FAILED", "The desktop portal request failed", FALSE);
  }
}

static void respond(Request *request, guint32 response)
{
  if (response == 0) finish(request, NULL, NULL, FALSE);
  else if (response == 1)
    finish(request, "ERR_PORTAL_CANCELLED", "Opening the URI was cancelled", FALSE);
  else finish(request, "ERR_PORTAL_FAILED", "The desktop portal could not open the URI", FALSE);
}

static void response_received(GDBusConnection *bus, const char *sender, const char *path,
                              const char *interface, const char *signal,
                              GVariant *parameters, gpointer data)
{
  Request *request = data;
  guint32 response;
  (void)bus; (void)sender; (void)interface; (void)signal;
  if (request->done || !g_str_has_prefix(path, REQUEST_PREFIX) ||
      !g_variant_is_of_type(parameters, G_VARIANT_TYPE("(ua{sv})"))) return;
  g_variant_get_child(parameters, 0, "u", &response);
  if (!request->replied) {
    /* Also retain early responses for portals returning a different handle. */
    g_hash_table_replace(request->early_responses, g_strdup(path),
                         GUINT_TO_POINTER(MIN(response, 2) + 1));
  } else if (g_str_equal(path, request->path)) respond(request, response);
}

static void method_returned(GObject *object, GAsyncResult *result, gpointer data)
{
  Request *request = data;
  GError *error = NULL;
  GVariant *reply = g_dbus_connection_call_with_unix_fd_list_finish(
      G_DBUS_CONNECTION(object), NULL, result, &error);
  request->pending--;
  if (request->done || error) {
    fail_dbus(request, error, FALSE);
  } else {
    const char *path;
    g_variant_get(reply, "(&o)", &path);
    g_free(request->path);
    request->path = g_strdup(path);
    request->replied = TRUE;
    gpointer early = g_hash_table_lookup(request->early_responses, path);
    g_hash_table_remove_all(request->early_responses);
    if (early) respond(request, GPOINTER_TO_UINT(early) - 1);
  }
  g_clear_pointer(&reply, g_variant_unref);
  g_clear_error(&error);
}

static void disconnected(GDBusConnection *bus, gboolean vanished, GError *error, gpointer data)
{
  (void)bus; (void)vanished; (void)error;
  finish(data, "ERR_PORTAL_UNAVAILABLE", "The session bus disconnected", FALSE);
}

static void connected(GObject *object, GAsyncResult *result, gpointer data)
{
  Request *request = data;
  GError *error = NULL;
  GUnixFDList *fds = NULL;
  GVariant *arguments;
  const char *method = "OpenURI";
  (void)object;
  request->bus = g_dbus_connection_new_for_address_finish(result, &error);
  request->pending--;
  if (request->done || error) {
    fail_dbus(request, error, TRUE);
    g_clear_error(&error);
    return;
  }
  g_dbus_connection_set_exit_on_close(request->bus, FALSE);
  request->closed_handler = g_signal_connect(request->bus, "closed", G_CALLBACK(disconnected), request);
  char *sender = g_strdup(g_dbus_connection_get_unique_name(request->bus) + 1);
  for (char *p = sender; *p; p++) if (*p == '.') *p = '_';
  char *token = g_strdup_printf("qq_%u_%" G_GUINT64_FORMAT, (unsigned)getpid(), ++request->bridge->sequence);
  request->path = g_strconcat(REQUEST_PREFIX, sender, "/", token, NULL);
  g_free(sender);
  request->subscription = g_dbus_connection_signal_subscribe(
      request->bus, PORTAL_NAME, REQUEST_INTERFACE, "Response", NULL, NULL,
      G_DBUS_SIGNAL_FLAGS_NONE, response_received, request, NULL);
  GVariantBuilder options;
  g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
  g_free(token);
  if (g_ascii_strncasecmp(request->uri, "file:", 5) == 0) {
    char *hostname = NULL;
    char *filename = g_filename_from_uri(request->uri, &hostname, &error);
    int fd = filename && (!hostname || g_ascii_strcasecmp(hostname, "localhost") == 0)
        ? open(filename, O_PATH | O_CLOEXEC) : -1;
    g_free(filename);
    g_free(hostname);
    if (fd >= 0) {
      fds = g_unix_fd_list_new();
      if (g_unix_fd_list_append(fds, fd, &error) < 0) g_clear_object(&fds);
      close(fd);
    }
    if (!fds) {
      g_variant_builder_clear(&options);
      g_clear_error(&error);
      finish(request, "ERR_PORTAL_FAILED", "The local file could not be opened", FALSE);
      return;
    }
    method = "OpenFile";
    arguments = g_variant_new("(sha{sv})", "", 0, &options);
  } else arguments = g_variant_new("(ssa{sv})", "", request->uri, &options);
  request->pending++;
  g_dbus_connection_call_with_unix_fd_list(
      request->bus, PORTAL_NAME, PORTAL_PATH, OPEN_INTERFACE, method,
      arguments, G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE,
      QQ_PORTAL_TIMEOUT_MS, fds, request->cancel, method_returned, request);
  g_clear_object(&fds);
}

static gboolean timed_out(gpointer data)
{
  finish(data, "ERR_PORTAL_TIMEOUT", "The desktop portal request timed out", TRUE);
  return G_SOURCE_REMOVE;
}

static gboolean start_request(gpointer data)
{
  Request *request = data;
  Bridge *bridge = request->bridge;
  bridge->requests = g_list_prepend(bridge->requests, request);
  request->cancel = g_cancellable_new();
  request->early_responses = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
  request->timeout = g_timeout_source_new(QQ_PORTAL_TIMEOUT_MS);
  g_source_set_callback(request->timeout, timed_out, request, NULL);
  g_source_attach(request->timeout, bridge->context);
  request->pending++;
  g_dbus_connection_new_for_address(
      request->address, G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
      G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
      NULL, request->cancel, connected, request);
  return G_SOURCE_REMOVE;
}

static void post(Bridge *bridge, GSourceFunc callback, gpointer data)
{
  GSource *source = g_idle_source_new();
  g_source_set_callback(source, callback, data, NULL);
  g_source_attach(source, bridge->context);
  g_source_unref(source);
}

static gpointer run(gpointer data)
{
  Bridge *bridge = data;
  g_main_context_push_thread_default(bridge->context);
  g_main_loop_run(bridge->loop);
  g_main_context_pop_thread_default(bridge->context);
  napi_release_threadsafe_function(bridge->results, napi_tsfn_abort);
  return NULL;
}

static gboolean stop(gpointer data)
{
  Bridge *bridge = data;
  bridge->stopping = TRUE;
  GList *next;
  for (GList *item = bridge->requests; item; item = next) {
    next = item->next;
    finish(item->data, "ERR_PORTAL_CANCELLED", "The application is shutting down", TRUE);
  }
  if (bridge->requests == NULL) g_main_loop_quit(bridge->loop);
  return G_SOURCE_REMOVE;
}

static void cleanup(void *data)
{
  Bridge *bridge = data;
  post(bridge, stop, bridge);
  /* All I/O is cancellable; Close is bounded to one second. No JS is needed. */
  g_thread_join(bridge->thread);
  bridge->thread = NULL;
}

static void finalize(napi_env env, void *data, void *hint)
{
  Bridge *bridge = data;
  (void)env; (void)hint;
  g_main_loop_unref(bridge->loop);
  g_main_context_unref(bridge->context);
  g_free(bridge);
}

static void settle(napi_env env, napi_deferred deferred, const char *code, const char *message)
{
  napi_value value, text, error_code;
  if (!code) {
    napi_get_undefined(env, &value);
    napi_resolve_deferred(env, deferred, value);
  } else {
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &error_code);
    napi_create_error(env, error_code, text, &value);
    napi_reject_deferred(env, deferred, value);
  }
}

static void deliver(napi_env env, napi_value callback, void *context, void *data)
{
  Request *request = data;
  Bridge *bridge = context;
  (void)callback;
  if (env) {
    settle(env, request->deferred, request->code, request->message);
    if (--bridge->active_js == 0) napi_unref_threadsafe_function(env, bridge->results);
  }
  request_free(request);
}

static char *bus_address(void)
{
  const char *configured = g_getenv("DBUS_SESSION_BUS_ADDRESS");
  char *address = configured && *configured ? g_strdup(configured) : NULL;
  if (!address) {
    const char *runtime = g_getenv("XDG_RUNTIME_DIR");
    if (!runtime || !g_path_is_absolute(runtime)) return NULL;
    char *path = g_build_filename(runtime, "bus", NULL);
    char *escaped = g_dbus_address_escape_value(path);
    address = g_strconcat("unix:path=", escaped, NULL);
    g_free(escaped);
    g_free(path);
  }
  /* Never allow GIO's autolaunch or executable transports to spawn a helper. */
  char **entries = g_strsplit(address, ";", -1);
  gboolean valid = TRUE;
  for (char **entry = entries; *entry; entry++)
    if (!g_str_has_prefix(*entry, "unix:") || !g_dbus_is_supported_address(*entry, NULL)) valid = FALSE;
  g_strfreev(entries);
  if (!valid) g_clear_pointer(&address, g_free);
  return address;
}

static napi_value open_uri(napi_env env, napi_callback_info info)
{
  size_t argc = 1, length;
  napi_value argv[1], promise;
  napi_valuetype type;
  void *data;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok || argc != 1 ||
      napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "openURI expects a URI string");
    return NULL;
  }
  Request *request = g_new0(Request, 1);
  request->bridge = data;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok) goto napi_failure;
  request->uri = g_malloc(length + 1);
  if (napi_get_value_string_utf8(env, argv[0], request->uri, length + 1, NULL) != napi_ok) goto napi_failure;
  if (strlen(request->uri) != length || !g_uri_peek_scheme(request->uri)) {
    request_free(request);
    napi_throw_type_error(env, NULL, "openURI expects an absolute URI without NUL characters");
    return NULL;
  }
  if (napi_create_promise(env, &request->deferred, &promise) != napi_ok) goto napi_failure;
  request->address = bus_address();
  if (!request->address) {
    settle(env, request->deferred, "ERR_PORTAL_UNAVAILABLE", "A local session bus is required");
    request_free(request);
    return promise;
  }
  Bridge *bridge = request->bridge;
  if (bridge->active_js++ == 0) napi_ref_threadsafe_function(env, bridge->results);
  post(bridge, start_request, request);
  return promise;
napi_failure:
  request_free(request);
  napi_throw_error(env, NULL, "Could not create the portal request");
  return NULL;
}

NAPI_MODULE_INIT()
{
  Bridge *bridge = g_new0(Bridge, 1);
  bridge->context = g_main_context_new();
  bridge->loop = g_main_loop_new(bridge->context, FALSE);
  napi_value name;
  napi_create_string_utf8(env, "QQ desktop portal", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, bridge,
      finalize, bridge, deliver, &bridge->results) != napi_ok) {
    finalize(env, bridge, NULL);
    napi_throw_error(env, NULL, "Could not initialize the portal bridge");
    return NULL;
  }
  napi_unref_threadsafe_function(env, bridge->results);
  bridge->thread = g_thread_try_new("qq-portal", run, bridge, NULL);
  if (!bridge->thread) {
    napi_release_threadsafe_function(bridge->results, napi_tsfn_abort);
    napi_throw_error(env, NULL, "Could not start the portal thread");
    return NULL;
  }
  if (napi_add_env_cleanup_hook(env, cleanup, bridge) != napi_ok) {
    cleanup(bridge);
    napi_throw_error(env, NULL, "Could not register portal cleanup");
    return NULL;
  }
  napi_property_descriptor property = { "openURI", NULL, open_uri, NULL, NULL, NULL, napi_default, bridge };
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) return NULL;
  return exports;
}
