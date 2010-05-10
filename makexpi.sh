#!/bin/sh
rm -Rf build release.xpi
mkdir build

cp chrome.manifest.rel build/chrome.manifest

cp -R install.rdf icon.png defaults modules build
zip -r build/bartab.jar content locale

cd build
zip -r ../release.xpi *
