#ifndef FLUTTER_PLUGIN_LIBBOX_BRIDGE_PLUGIN_H_
#define FLUTTER_PLUGIN_LIBBOX_BRIDGE_PLUGIN_H_

#include <flutter_linux/flutter_linux.h>
#include <glib-object.h>

#ifdef FLUTTER_PLUGIN_IMPL
#define FLUTTER_PLUGIN_EXPORT __attribute__((visibility("default")))
#else
#define FLUTTER_PLUGIN_EXPORT
#endif

G_DECLARE_FINAL_TYPE(LibboxBridgePlugin, libbox_bridge_plugin, LIBBOX_BRIDGE, PLUGIN, GObject)

G_BEGIN_DECLS

FLUTTER_PLUGIN_EXPORT void libbox_bridge_plugin_register_with_registrar(FlPluginRegistrar* registrar);

G_END_DECLS

#endif  // FLUTTER_PLUGIN_LIBBOX_BRIDGE_PLUGIN_H_
