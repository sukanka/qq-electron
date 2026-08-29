#!/usr/bin/bash
compat_library=/usr/lib/qq/libqq-electron-compat.so
case ":${LD_PRELOAD-}:" in
*":${compat_library}:"*) ;;
*) export LD_PRELOAD="${compat_library}${LD_PRELOAD:+:${LD_PRELOAD}}" ;;
esac

exec /usr/bin/__ELECTRON__ /usr/lib/qq/resources/app "$@"
