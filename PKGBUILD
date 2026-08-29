# Maintainer: sukanka

_base_pkgver=3.2.33-52892
_nt_ver=9.9.35
_md5=1763096b
_electron=electron40
pkgname=qq-electron
pkgver="${_base_pkgver//-/_}"
pkgrel=1
pkgdesc='Tencent QQ running on the system Electron 40 runtime'
arch=('x86_64')
url='https://im.qq.com/linuxqq/index.shtml'
license=('LicenseRef-Tencent-QQ')
depends=($_electron)
makedepends=('git')
optdepends=(
	'gjs: GNOME Wayland screenshot support'
	'libappindicator-gtk3: system tray icon support'
)
provides=('qq' 'linuxqq')
conflicts=('linuxqq' 'linuxqq-nt-bwrap')
options=('!emptydirs' '!strip')

_url_prefix="https://qqdl.gtimg.cn/qqfile/QQNT/${_nt_ver}/beta/${_md5}"
source_x86_64=("${_url_prefix}/linuxqq_${_base_pkgver}_amd64.deb")
source=('git+https://github.com/sukanka/qq-electron.git')
sha256sums=('SKIP')
sha256sums_x86_64=('502a978f2d03af9f21acefc461f9d1d1fe09b65bad620bbfcdb589a79ac53b7e')

prepare() {
	local source_root="${srcdir}/linuxqq-root"

	rm -rf -- "${source_root}"
	install -d "${source_root}"
	tar --no-same-owner -xJf "${srcdir}/data.tar.xz" -C "${source_root}"

	sed -i \
		's|"main": "./application.asar/app_launcher/index.js"|"main": "./main.js"|' \
		"${source_root}/opt/QQ/resources/app/package.json"
	grep -q '"main": "./main.js"' \
		"${source_root}/opt/QQ/resources/app/package.json"
	sed -i 's|^Icon=.*|Icon=qq|' \
		"${source_root}/usr/share/applications/qq.desktop"
}

build() {
	cc ${CPPFLAGS} ${CFLAGS} -fPIC -shared \
		-Wl,-soname,libqq-electron-compat.so \
		-o "${srcdir}/libqq-electron-compat.so" \
		"${srcdir}/qq-electron/electron-compat.c" \
		${LDFLAGS} -ldl
}

package() {
	local repo_dir="${srcdir}/qq-electron"
	local source_root="${srcdir}/linuxqq-root"

	install -d "${pkgdir}/opt/QQ/resources"
	cp -ar "${source_root}/opt/QQ/resources/app" \
		"${pkgdir}/opt/QQ/resources/"
	install -Dm644 \
		"${source_root}/opt/QQ/version.json" \
		-t "${pkgdir}/opt/QQ"
	install -Dm644 "${source_root}/usr/share/applications/qq.desktop" \
		"${pkgdir}/usr/share/applications/qq.desktop"
	install -Dm644 "${source_root}/usr/share/icons/hicolor/512x512/apps/qq.png" \
		"${pkgdir}/usr/share/icons/hicolor/512x512/apps/qq.png"
	install -Dm644 "${source_root}/usr/share/doc/linuxqq/changelog.gz" \
		"${pkgdir}/usr/share/doc/${pkgname}/changelog.gz"

	install -Dm755 "${repo_dir}/qq-electron.sh" "${pkgdir}/opt/QQ/qq"
	install -Dm755 "${srcdir}/libqq-electron-compat.so" \
		"${pkgdir}/opt/QQ/libqq-electron-compat.so"
	install -Dm644 \
		"${repo_dir}/code-cache.js" \
		"${repo_dir}/main.js" \
		"${repo_dir}/preload.js" \
		"${repo_dir}/session-preload.js" \
		-t "${pkgdir}/opt/QQ/resources/app"

	local preload_loader
	for preload_loader in \
		p_preload p_preloadAux p_preload_browserview p_preload_chatwin \
		p_preload_ex_browser p_preload_ex p_preload_login \
		p_preload_qq_browser_base p_preload_qq_browser_mixed \
		p_preload_qq_browser_simple p_preload_qzone_view p_preload_simple \
		p_preload_webview; do
		ln "${pkgdir}/opt/QQ/resources/app/session-preload.js" \
			"${pkgdir}/opt/QQ/resources/app/session-preload-${preload_loader}.js"
	done

	install -d "${pkgdir}/usr/bin"
	ln -s /opt/QQ/qq "${pkgdir}/usr/bin/qq"
}
