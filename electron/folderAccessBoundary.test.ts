import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
// Parse imports rather than matching local names: aliases and namespace imports must not bypass this guard.
const forbidden = new Set(["updateAllowlist", "writeAllowlist", "withAllowlistLock", "applyGrants"]);
it("keeps all grant writers out of MCP and desktop agent request modules", () => {
  const files = [...sources("mcp"), "electron/agentRequests.ts", "electron/agentRequestTargets.ts", "electron/agentPreparation.ts"];
  const offenders: string[] = [];
  for (const file of files) {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = node.moduleSpecifier.text;
        const bindings = node.importClause?.namedBindings;
        const writerModule = /(?:consent\/folderAccess|(?:^|\/)electron\/folderAccess|^\.\/folderAccess)(?:\.js)?$/.test(target);
        const consentModule = /consent\/allowlist(?:File)?(?:\.js)?$/.test(target);
        const writerBinding = bindings !== undefined && (ts.isNamespaceImport(bindings)
          ? consentModule
          : bindings.elements.some(binding => forbidden.has((binding.propertyName ?? binding.name).text)));
        if (writerModule || writerBinding) offenders.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const target = node.arguments[0];
        if (target !== undefined && ts.isStringLiteral(target) && /(?:consent\/(?:allowlist|allowlistFile|folderAccess)|(?:^|\/)folderAccess)(?:\.js)?$/.test(target.text)) {
          offenders.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(offenders).toEqual([]);
});
