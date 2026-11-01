import { expectTypeOf, it } from "vitest";
import type { FolderRow } from "../dist-core/consent/folderAccess.js";
import type { FolderAccessReply as MainReply } from "./folderAccess.js";
import type { FolderAccessReply as RendererReply, FolderAccessRow } from "../src/global.js";

it("keeps the renderer and privileged folder contracts assignable in both directions", () => {
  expectTypeOf<FolderRow>().toExtend<FolderAccessRow>();
  expectTypeOf<FolderAccessRow>().toExtend<FolderRow>();
  expectTypeOf<MainReply>().toExtend<RendererReply>();
  expectTypeOf<RendererReply>().toExtend<MainReply>();
});
