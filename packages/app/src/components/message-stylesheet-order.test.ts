import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Unistyles runs a StyleSheet.create factory while the module is still evaluating. A factory
// that reaches a module const declared further down the file, directly or through a hoisted
// helper function, throws a TDZ ReferenceError and the web/desktop renderer never starts.
// message.tsx pulls in too much of the app to import in a test, so this checks the source order.
describe("message.tsx stylesheet factories", () => {
  it("only reach module constants declared above them", () => {
    const path = "./message.tsx";
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL(path, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const constants = new Map<string, ts.Statement>();
    const functions = new Map<string, ts.FunctionDeclaration>();
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        functions.set(statement.name.text, statement);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) constants.set(declaration.name.text, statement);
        }
      }
    }

    let factoriesChecked = 0;
    for (const statement of source.statements) {
      function findFactories(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "StyleSheet.create" &&
          node.arguments[0]
        ) {
          factoriesChecked++;
          const visited = new Set<ts.Node>();
          function reach(inner: ts.Node, via: string) {
            if (
              ts.isIdentifier(inner) &&
              !(ts.isPropertyAccessExpression(inner.parent) && inner.parent.name === inner) &&
              !(ts.isPropertyAssignment(inner.parent) && inner.parent.name === inner)
            ) {
              const declared = constants.get(inner.text);
              if (declared) {
                expect(
                  declared.getStart(source) < statement.getStart(source),
                  `${via} reads ${inner.text} before it is initialized`,
                ).toBe(true);
              }
              const helper = functions.get(inner.text);
              if (helper && !visited.has(helper)) {
                visited.add(helper);
                reach(helper, `${via} -> ${inner.text}`);
                return;
              }
            }
            ts.forEachChild(inner, (child) => reach(child, via));
          }
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          reach(node.arguments[0], `StyleSheet.create at message.tsx:${line}`);
        }
        ts.forEachChild(node, findFactories);
      }
      if (ts.isVariableStatement(statement)) findFactories(statement);
    }

    expect(factoriesChecked).toBeGreaterThan(0);
  });
});
