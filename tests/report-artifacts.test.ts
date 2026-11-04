import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectReportArtifacts } from "../packages/core/report-artifacts.js";

function workspace(t: TestContext) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-report-artifacts-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  return { root, cwd };
}

test("checks exact relative filenames mentioned in both the request and final answer", (t) => {
  const { cwd } = workspace(t);
  mkdirSync(join(cwd, "产物"));
  writeFileSync(join(cwd, "产物", "验收 汇总.md"), "你好");
  writeFileSync(join(cwd, "预览.png"), "");
  assert.deepEqual(
    inspectReportArtifacts(
      cwd,
      [
        "请返回 `./产物/验收 汇总.md`、预览.png 和 package.zip，附加 optional.txt。",
      ],
      "已整理 `产物/验收 汇总.md`、预览.png 和 package.zip；另有 extra.txt。",
    ),
    [
      { path: "产物/验收 汇总.md", status: "present", bytes: 6 },
      { path: "预览.png", status: "present", bytes: 0 },
      { path: "package.zip", status: "absent" },
    ],
  );
  assert.deepEqual(
    inspectReportArtifacts(cwd, ["请创建报告.txt"], "已生成报告.txt。"),
    [{ path: "报告.txt", status: "absent" }],
  );
  assert.deepEqual(
    inspectReportArtifacts(cwd, ["a/report.pdf"], "b/report.pdf"),
    [],
  );
});

test(
  "never follows symlinks at any component",
  { skip: process.platform === "win32" },
  (t) => {
    const { root, cwd } = workspace(t);
    writeFileSync(join(root, "private.txt"), "fixture");
    symlinkSync(root, join(cwd, "external"), "dir");
    symlinkSync(join(root, "private.txt"), join(cwd, "alias.txt"));
    const refs = "external/private.txt alias.txt";
    assert.deepEqual(inspectReportArtifacts(cwd, [refs], refs), []);
  },
);

test("skips private names, external and ambiguous references", (t) => {
  const { cwd, root } = workspace(t);
  const refs = [
    "../private.txt",
    join(root, "private.txt"),
    "keys.json",
    "私钥.txt",
    "cat notes.md",
    ".hidden/report.json",
    "credentials.json",
    "auth.json",
    "private-key.txt",
    "令牌.txt",
    "https://example.test/report.md",
    "~/report.md",
    "*.png",
    "file:///docs/a.pdf",
    "report.md.bak",
  ]
    .map((s) => "`" + s + "`")
    .join(" ");
  assert.deepEqual(inspectReportArtifacts(cwd, [refs], refs), []);
  const external =
    "https://example.test/?foreign.md [remote.txt](https://example.test/doc)";
  assert.deepEqual(inspectReportArtifacts(cwd, [external], external), []);
});

test("deduplicates references, caps probes and skips an unavailable project", (t) => {
  const { cwd } = workspace(t);
  const names = "a.md a.md b.txt c.webp d.tar.gz e.csv";
  assert.deepEqual(
    inspectReportArtifacts(cwd, [names], names).map((f) => f.path),
    ["a.md", "b.txt", "c.webp", "d.tar.gz"],
  );
  assert.deepEqual(
    inspectReportArtifacts(join(cwd, "missing"), ["a.md"], "a.md"),
    [],
  );
});
