#!/usr/bin/env node
// Runtime and companion artwork share the native Cinderdeck app's source icon.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const source = NodePath.join(root, "../assets/cinderdeck-icon.png");
const macSource = NodePath.join(
  root,
  "../Cinderdeck/Resources/Assets.xcassets/AppIcon.appiconset/CinderdeckIcon-macOS-512x512@2x.png",
);
const check = process.argv.includes("--check");
const emberPath =
  "M5 10.4 16 4l11 6.4v4.4L16 8.4 5 14.8Z M5 15.8l7.4 4.3L5 24.4v4.4l11 6.4 11-6.4v-4.4l-11 6.4-7.4-4.3L17 21.6v-4.4L9.4 12.8Z";
const ember =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 36" width="32" height="36"><path d="' +
  emberPath +
  '" fill="#ffffff"/></svg>';
const outputs = new Map();
outputs.set(
  "apps/mobile/modules/t3-agent-notifications/android/src/main/res/drawable/agent_activity_mark.xml",
  Buffer.from(`<!-- Generated Cinderdeck notification mark. Run icons:export to refresh. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="40" android:viewportHeight="40">
    <group android:translateX="4">
        <path android:fillColor="#FFFFFFFF" android:pathData="${emberPath}" />
    </group>
</vector>
`),
);
const png = async (size) =>
  sharp(source).resize(size, size).flatten({ background: "#151c24" }).png().toBuffer();
const ico = (bytes, size) => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = header[7] = size >= 256 ? 0 : size;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(bytes.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, bytes]);
};
const full = await png(1024);
const mac = await NodeFSP.readFile(macSource);
const favicon16 = await png(16);
const favicon32 = await png(32);
const touch = await png(180);
for (const variant of ["dev", "nightly", "prod"]) {
  const prefix = `assets/cinderdeck/${variant}`;
  for (const [name, bytes] of Object.entries({
    "ios-1024.png": full,
    "macos-1024.png": mac,
    "web-apple-touch-180.png": touch,
    "web-favicon-16x16.png": favicon16,
    "web-favicon-32x32.png": favicon32,
    "web-favicon.ico": ico(favicon32, 32),
  }))
    outputs.set(`${prefix}/${name}`, bytes);
}
for (const [name, bytes] of Object.entries({
  "apple-touch-icon.png": touch,
  "favicon-16x16.png": favicon16,
  "favicon-32x32.png": favicon32,
  "favicon.ico": ico(favicon32, 32),
}))
  outputs.set(`apps/web/public/${name}`, bytes);
const mark = await sharp(Buffer.from(ember)).resize(192, 216).png().toBuffer();
const foreground = await sharp({
  create: { width: 432, height: 432, channels: 4, background: "#00000000" },
})
  .composite([{ input: mark, gravity: "centre" }])
  .png()
  .toBuffer();
const splash = await sharp(foreground)
  .flatten({ background: "#151c24" })
  .resize(1152, 1152)
  .png()
  .toBuffer();
outputs.set("apps/mobile/assets/android-icon-foreground.png", foreground);
for (const name of ["android-icon-mark.png", "android-notification-icon.png"])
  outputs.set(`apps/mobile/assets/${name}`, foreground);
for (const variant of ["dev", "nightly", "prod"])
  outputs.set(`apps/mobile/assets/android-splash-icon-${variant}.png`, splash);
for (const variant of ["dev", "nightly"])
  outputs.set(
    `apps/mobile/assets/android-icon-background-${variant}.png`,
    await sharp({ create: { width: 432, height: 432, channels: 4, background: "#151c24" } })
      .png()
      .toBuffer(),
  );
for (const [relative, bytes] of outputs) {
  const destination = NodePath.join(root, relative);
  if (check) {
    const existing = await NodeFSP.readFile(destination);
    if (!existing.equals(bytes)) throw new Error(`Stale Cinderdeck artwork: ${relative}`);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, bytes);
  }
}
console.log(`${check ? "Verified" : "Exported"} ${outputs.size} Cinderdeck icons.`);
