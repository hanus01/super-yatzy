#!/bin/bash
# Build a C++26 macOS app and bundle its non-system shared libraries.
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
build_dir="${YATZY_BUILD_DIR:-$source_dir/.build/super-yatzy}"
app_output="${YATZY_APP_OUTPUT:-$source_dir/../Super Yatzy.app}"
sfml_prefix="${SFML_PREFIX:-}"

if [[ -z "$sfml_prefix" ]]; then
    for candidate in /opt/homebrew/opt/sfml@2 /usr/local/opt/sfml@2; do
        if [[ -f "$candidate/include/SFML/Graphics.hpp" ]]; then
            sfml_prefix="$candidate"
            break
        fi
    done
fi

if [[ -z "$sfml_prefix" || ! -f "$sfml_prefix/include/SFML/Graphics.hpp" ]]; then
    printf 'SFML 2 is required to rebuild. Install Homebrew, then run: brew install sfml@2\n' >&2
    exit 1
fi

if ! xcrun --find clang++ >/dev/null 2>&1; then
    printf 'Install the Xcode command-line tools with: xcode-select --install\n' >&2
    exit 1
fi

mkdir -p "$build_dir"
staging_parent="$(mktemp -d "$build_dir/staging.XXXXXXXX")"
trap 'rm -rf -- "$staging_parent"' EXIT
staged_app="$staging_parent/Super Yatzy.app"
mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Frameworks" "$staged_app/Contents/Resources"

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
printf 'Building the C++26 game...\n'
xcrun clang++ -std=c++26 -O2 -Wall -Wextra -Wpedantic \
    -isystem "$sfml_prefix/include" "$source_dir/main.cpp" "$source_dir/macos_display.mm" \
    -L"$sfml_prefix/lib" -lsfml-graphics -lsfml-window -lsfml-system \
    -framework AppKit -framework OpenGL \
    -Wl,-rpath,"$sfml_prefix/lib" -Wl,-headerpad_max_install_names \
    -o "$staged_app/Contents/MacOS/super-yatzy"

printf 'Bundling the graphics libraries...\n'
/usr/bin/python3 - "$staged_app" "$sfml_prefix" "$source_dir" <<'PY'
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

app, sfml, source = map(Path, sys.argv[1:])
executable = app / 'Contents/MacOS/super-yatzy'
frameworks = app / 'Contents/Frameworks'
resources = app / 'Contents/Resources'

def output(*args):
    return subprocess.check_output(args, text=True)

def dependencies(path):
    return [line.strip().split(' (compatibility version', 1)[0]
            for line in output('/usr/bin/otool', '-L', str(path)).splitlines()[1:]]

def runpaths(path):
    lines = output('/usr/bin/otool', '-l', str(path)).splitlines()
    paths = []
    for index, line in enumerate(lines):
        if line.strip() == 'cmd LC_RPATH':
            paths.append(lines[index + 2].strip().split('path ', 1)[1].split(' (offset', 1)[0])
    return paths

def is_system(path):
    return path.startswith(('/System/', '/usr/lib/'))

def resolve(reference, owner):
    if reference.startswith('@loader_path/'):
        return (owner.parent / reference[len('@loader_path/'):]).resolve()
    if reference.startswith('@executable_path/'):
        return (executable.parent / reference[len('@executable_path/'):]).resolve()
    if reference.startswith('@rpath/'):
        suffix = reference[len('@rpath/'):]
        for directory in [*runpaths(owner), str(sfml / 'lib'), str(owner.parent)]:
            directory = directory.replace('@loader_path', str(owner.parent))
            directory = directory.replace('@executable_path', str(executable.parent))
            candidate = Path(directory) / suffix
            if candidate.exists():
                return candidate.resolve()
        raise RuntimeError(f'Cannot resolve {reference} used by {owner}')
    path = Path(reference)
    if not path.exists():
        raise RuntimeError(f'Missing graphics dependency: {reference}')
    return path.resolve()

processed = set()

def bundle(original, destination):
    original = original.resolve()
    if original in processed:
        return
    processed.add(original)
    refs = dependencies(original)
    if original != executable.resolve():
        shutil.copyfile(original, destination)
        destination.chmod(0o755)
    subprocess.run(['/usr/bin/codesign', '--remove-signature', str(destination)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if original != executable.resolve():
        subprocess.run(['/usr/bin/install_name_tool', '-id',
                        '@executable_path/../Frameworks/' + destination.name,
                        str(destination)], check=True)
    for reference in refs:
        if is_system(reference):
            continue
        resolved = resolve(reference, original)
        if resolved == original:
            continue  # A dylib's own install name, already changed above.
        target = frameworks / resolved.name
        bundle(resolved, target)
        subprocess.run(['/usr/bin/install_name_tool', '-change', reference,
                        '@executable_path/../Frameworks/' + target.name,
                        str(destination)], check=True)
    for rpath in runpaths(destination):
        if rpath.startswith(('/opt/homebrew/', '/usr/local/')):
            subprocess.run(['/usr/bin/install_name_tool', '-delete_rpath', rpath,
                            str(destination)], check=True)

bundle(executable, executable)

for binary in [executable, *frameworks.glob('*.dylib')]:
    for reference in dependencies(binary):
        if not is_system(reference) and not reference.startswith('@executable_path/../Frameworks/'):
            raise RuntimeError(f'Unbundled dependency in {binary}: {reference}')

icon = source / 'assets/SuperYatzy.icns'
if icon.exists():
    shutil.copy2(icon, resources / icon.name)
if (source / 'licenses').exists():
    shutil.copytree(source / 'licenses', resources / 'Licenses', dirs_exist_ok=True)
shutil.copy2(source / 'README.md', resources / 'README.md')

info = {
    'CFBundleName': 'Super Yatzy',
    'CFBundleDisplayName': 'Super Yatzy',
    'CFBundleIdentifier': 'local.superyatzy.game',
    'CFBundleExecutable': 'super-yatzy',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '1.1',
    'CFBundleVersion': '2',
    'CFBundleIconFile': 'SuperYatzy.icns',
    'LSMinimumSystemVersion': os.environ.get('MACOSX_DEPLOYMENT_TARGET', '15.0'),
    'NSHighResolutionCapable': True,
    'LSApplicationCategoryType': 'public.app-category.board-games',
}
with (app / 'Contents/Info.plist').open('wb') as file:
    plistlib.dump(info, file)
PY

# Documents may be managed by iCloud, which adds Finder metadata to new folders.
# Clear that metadata from our generated bundle before signing it.
/usr/bin/xattr -cr "$staged_app"
/usr/bin/xattr -d com.apple.FinderInfo "$staged_app" 2>/dev/null || true
for library in "$staged_app/Contents/Frameworks/"*.dylib; do
    /usr/bin/codesign --force --sign - "$library"
done
/usr/bin/codesign --force --sign - "$staged_app"
/usr/bin/codesign --verify --deep --strict "$staged_app"

# Replace only this script's generated app, after a successful build.
if [[ -e "$app_output" ]]; then
    if [[ ! -f "$app_output/Contents/MacOS/super-yatzy" ]]; then
        printf 'Refusing to replace an unrelated item at %s\n' "$app_output" >&2
        exit 1
    fi
    rm -rf -- "$app_output"
fi
/usr/bin/ditto "$staged_app" "$app_output"
# iCloud can attach Finder metadata asynchronously just after the copy.  A
# short retry clears it from this generated app before checking its signature.
copy_verified=false
for attempt in 1 2 3; do
    /usr/bin/xattr -cr "$app_output"
    /usr/bin/xattr -d com.apple.FinderInfo "$app_output" 2>/dev/null || true
    if /usr/bin/codesign --verify --deep --strict "$app_output" 2>"$staging_parent/verify.log"; then
        copy_verified=true
        break
    fi
    sleep 0.2
done
if [[ "$copy_verified" != true ]]; then
    cat "$staging_parent/verify.log" >&2
    exit 1
fi
printf '\nReady: %s\nDouble-click Super Yatzy.app to play.\n' "$app_output"
