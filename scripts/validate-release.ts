const tag = process.env.RELEASE_TAG || "";
const { version } = await Bun.file("version.json").json();
if (!/^v\d+\.\d+\.\d+(-beta\.\d+)?$/.test(tag) || tag !== `v${version}`) throw new Error("Tag must match version.json and use a stable or beta version");
console.log(`Validated ${tag}`);
