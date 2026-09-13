#include "libbox_bridge_plugin.h"

#include <flutter_linux/flutter_linux.h>
#include <gtk/gtk.h>

#include <cstring>

struct _LibboxBridgePlugin {
  GObject parent_instance;
};

G_DEFINE_TYPE(LibboxBridgePlugin, libbox_bridge_plugin, g_object_get_type())

static void libbox_bridge_plugin_handle_method_call(
    FlMethodChannel* channel,
    FlMethodCall* method_call,
    gpointer user_data) {
  auto* self = LIBBOX_BRIDGE_PLUGIN(user_data);
  (void)self;
  (void)channel;
  const gchar* method = fl_method_call_get_name(method_call);
  g_autoptr(FlMethodResponse) response = nullptr;

  if (strcmp(method, "isAvailable") == 0) {
    g_autoptr(FlValue) value = fl_value_new_bool(FALSE);
    response = FL_METHOD_RESPONSE(fl_method_success_response_new(value));
  } else if (strcmp(method, "initialize") == 0) {
    response = FL_METHOD_RESPONSE(fl_method_success_response_new(nullptr));
  } else {
    response = FL_METHOD_RESPONSE(fl_method_not_implemented_response_new());
  }

  fl_method_call_respond(method_call, response, nullptr);
}

static void libbox_bridge_plugin_dispose(GObject* object) {
  G_OBJECT_CLASS(libbox_bridge_plugin_parent_class)->dispose(object);
}

static void libbox_bridge_plugin_class_init(LibboxBridgePluginClass* klass) {
  G_OBJECT_CLASS(klass)->dispose = libbox_bridge_plugin_dispose;
}

static void libbox_bridge_plugin_init(LibboxBridgePlugin* self) {}

void libbox_bridge_plugin_register_with_registrar(FlPluginRegistrar* registrar) {
  LibboxBridgePlugin* plugin = LIBBOX_BRIDGE_PLUGIN(g_object_new(
      libbox_bridge_plugin_get_type(), nullptr));
  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  g_autoptr(FlMethodChannel) channel = fl_method_channel_new(
      fl_plugin_registrar_get_messenger(registrar), "strict_proxy/libbox",
      FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(
      channel, libbox_bridge_plugin_handle_method_call,
      plugin, g_object_unref);
  g_object_unref(plugin);
}
