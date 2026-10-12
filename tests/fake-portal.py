#!/usr/bin/env python3
"""A private-bus portal fixture. Never launches applications or uses the desktop."""

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from gi.repository import Gio, GLib


OPEN_URI_XML = """
<node>
  <interface name="org.freedesktop.portal.OpenURI">
    <method name="OpenURI">
      <arg type="s" direction="in" name="parent_window"/>
      <arg type="s" direction="in" name="uri"/>
      <arg type="a{sv}" direction="in" name="options"/>
      <arg type="o" direction="out" name="handle"/>
    </method>
    <method name="OpenFile">
      <arg type="s" direction="in" name="parent_window"/>
      <arg type="h" direction="in" name="fd"/>
      <arg type="a{sv}" direction="in" name="options"/>
      <arg type="o" direction="out" name="handle"/>
    </method>
  </interface>
</node>
"""

REQUEST_XML = """
<node>
  <interface name="org.freedesktop.portal.Request">
    <method name="Close"/>
    <signal name="Response">
      <arg type="u" name="response"/>
      <arg type="a{sv}" name="results"/>
    </signal>
  </interface>
</node>
"""


class FakePortal:
    def __init__(self, log_path):
        self.log_file = open(log_path, "w", encoding="utf-8", buffering=1)
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.request_interface = Gio.DBusNodeInfo.new_for_xml(REQUEST_XML).interfaces[0]
        self.registrations = []
        interface = Gio.DBusNodeInfo.new_for_xml(OPEN_URI_XML).interfaces[0]
        self.registrations.append(self.connection.register_object(
            "/org/freedesktop/portal/desktop", interface, self.open_request, None, None
        ))
        reply = self.connection.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "RequestName",
            GLib.Variant("(su)", ("org.freedesktop.portal.Desktop", 0)),
            GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, -1, None,
        )
        if reply.unpack()[0] != 1:
            raise RuntimeError("The private test bus already has a portal owner")

    def record(self, **entry):
        self.log_file.write(json.dumps(entry) + "\n")

    def open_request(self, connection, sender, object_path, interface, method,
                     parameters, invocation):
        parent, value, options = parameters.unpack()
        token = options.get("handle_token")
        if not token:
            invocation.return_dbus_error(
                "org.freedesktop.DBus.Error.InvalidArgs", "handle_token is required"
            )
            return

        uri = value if method == "OpenURI" else "file:fixture"
        entry = {"event": "open", "method": method, "uri": uri,
                 "parent": parent, "token": token, "sender": sender}
        if method == "OpenFile":
            fd = invocation.get_message().get_unix_fd_list().get(value)
            try:
                stat = os.fstat(fd)
                entry["file_inode"] = stat.st_ino
                entry["file_device"] = stat.st_dev
            finally:
                os.close(fd)
        self.record(**entry)

        if urlsplit(uri).hostname == "method-error.test":
            invocation.return_dbus_error(
                "org.freedesktop.portal.Error.Failed", "Synthetic portal failure"
            )
            return

        sender_path = sender.lstrip(":").replace(".", "_")
        request_path = f"/org/freedesktop/portal/desktop/request/{sender_path}/{token}"

        def close_request(bus, caller, path, iface, name, args, call):
            self.record(event="close", token=token, uri=uri)
            call.return_value(GLib.Variant("()", ()))

        self.registrations.append(connection.register_object(
            request_path, self.request_interface, close_request, None, None
        ))

        hostname = urlsplit(uri).hostname
        code = {"cancel.test": 1, "failed.test": 2}.get(hostname, 0)

        def respond():
            self.record(event="response", token=token, uri=uri, code=code)
            connection.emit_signal(
                sender, request_path, "org.freedesktop.portal.Request", "Response",
                GLib.Variant("(ua{sv})", (code, {})),
            )
            return GLib.SOURCE_REMOVE

        if hostname == "early-response.test":
            # Send before the method reply to catch subscribing too late.
            respond()
        invocation.return_value(GLib.Variant("(o)", (request_path,)))
        if hostname not in ("early-response.test", "timeout.test"):
            delay = 650 if hostname == "late-response.test" else 80
            GLib.timeout_add(delay, respond)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready-file", required=True)
    parser.add_argument("--log-file", required=True)
    args = parser.parse_args()
    if os.environ.get("QQ_PORTAL_TEST_PRIVATE_BUS") != "1":
        parser.error("Only run this fixture through tests/portal-integration.sh")
    fixture = FakePortal(args.log_file)
    Path(args.ready_file).write_text("ready\n", encoding="utf-8")
    GLib.MainLoop().run()
    return fixture


if __name__ == "__main__":
    main()
