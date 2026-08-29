# Maintainer: sukanka

_base_pkgver=3.2.33-52892
_nt_ver=9.9.35
_md5=1763096b
_electron=electron40
pkgname=qq-electron
pkgver="${_base_pkgver//-/_}"
pkgrel=13
pkgdesc='Tencent QQ running on the system Electron 40 runtime'
arch=('x86_64')
url='https://im.qq.com/linuxqq/index.shtml'
license=('LicenseRef-Tencent-QQ')
depends=($_electron libssh2 libunwind)
makedepends=('asar' 'git')
optdepends=(
	'gjs: GNOME Wayland screenshot support'
	'libappindicator-gtk3: system tray icon support'
)
provides=('qq' 'linuxqq')
conflicts=('linuxqq' 'linuxqq-nt-bwrap')

_url_prefix="https://qqdl.gtimg.cn/qqfile/QQNT/${_nt_ver}/beta/${_md5}"
source_x86_64=("${_url_prefix}/linuxqq_${_base_pkgver}_amd64.deb")
source=(
	'git+https://github.com/sukanka/qq-electron.git'
	'qq-electron.sh'
)
sha256sums=('SKIP'
            'b8042dd1f0ce903570a3927eed4fc4e698ed94b96688b90ca5084d0684bffdf2')
sha256sums_x86_64=('502a978f2d03af9f21acefc461f9d1d1fe09b65bad620bbfcdb589a79ac53b7e')

prepare() {
	local source_root="${srcdir}/linuxqq-root"

	rm -rf -- "${source_root}"
	install -d "${source_root}"
	tar --no-same-owner -xJf "${srcdir}/data.tar.xz" -C "${source_root}"
	node "${srcdir}/qq-electron/scripts/decrypt-application.js" \
		"${source_root}/opt/QQ/resources/app/application.asar" \
		"${source_root}/opt/QQ/qq"
	rm -f "${source_root}/opt/QQ/resources/app"/{libssh2.so.1,avsdk/bugly/libssh2.so.1,libunwind{,-x86_64}.so.8,avsdk/bugly/libunwind{,-x86_64}.so.8}

	cd "${source_root}"
	sed -i opt/QQ/resources/app/package.json \
		-e 's|"main": "./application.asar/app_launcher/index.js"|"main": "./main.js"|'

	sed -i usr/share/applications/qq.desktop \
		-e 's|^Exec=.*|Exec=/usr/bin/qq %U|' -e 's|^Icon=.*|Icon=qq|'
	sed -i ${srcdir}/qq-electron.sh -e "s|__ELECTRON__|${_electron}|"

}

build() {
	cc ${CPPFLAGS} ${CFLAGS} -fPIC -shared \
		-Wl,-soname,libelectron-compat.so \
		-o "${srcdir}/libelectron-compat.so" \
		"${srcdir}/qq-electron/electron-compat.c" \
		${LDFLAGS} -ldl
}

_hack_preloaders() {

	pushd ${pkgdir}/usr/lib/QQ/resources/app/
	local preload_loader _preloaders
	_preloaders=(
		""
		Aux
		_browserview
		_chatwin
		_ex_browser
		_ex
		_login
		_qq_browser_base
		_qq_browser_mixed
		_qq_browser_simple
		_qzone_view
		_simple
		_webview
	)
	for preload_loader in "${_preloaders[@]}"; do
		ln session-preload.js "session-preload-p_preload${preload_loader}.js"
	done
	popd
}

package() {

	cd "${srcdir}/linuxqq-root"

	# FGESDK mistakes lowercase "qq" in native mapping paths for the main executable.
	install -d "${pkgdir}/usr/lib/QQ/resources"
	cp -ar "opt/QQ/resources/app" "${pkgdir}/usr/lib/QQ/resources/"
	cp -ar usr/share ${pkgdir}/usr/share
	install -Dm644 "opt/QQ/version.json" -t "${pkgdir}/usr/lib/QQ"
	install -Dm755 "${srcdir}/libelectron-compat.so" -t "${pkgdir}/usr/lib/QQ"
	install -Dm755 "${srcdir}/qq-electron.sh" "${pkgdir}/usr/bin/qq"

	cd ${srcdir}/qq-electron
	install -Dm644 *.js -t "${pkgdir}/usr/lib/QQ/resources/app"

	_hack_preloaders
}
