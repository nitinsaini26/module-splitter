/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  ASTra v3 — Exact AST-Walk Cognitive Complexity                             ║
 * ║                                                                              ║
 * ║  Replaces the line-level approximation with a precise recursive AST         ║
 * ║  traversal that tracks structural nesting depth exactly.                    ║
 * ║                                                                              ║
 * ║  Implements the SonarSource Cognitive Complexity specification (2018):       ║
 * ║                                                                              ║
 * ║  Increments (with nesting multiplier):                                       ║
 * ║    if / else if / else  ternary ? :                                         ║
 * ║    for / for-of / for-in / while / do-while                                 ║
 * ║    switch   catch   break/continue with label                               ║
 * ║    Nested function / method / lambda (increments nesting counter)           ║
 * ║                                                                              ║
 * ║  Boolean connectives (flat — no nesting multiplier):                        ║
 * ║    &&  ||  ??  (each sequence of the same operator counts once)             ║
 * ║                                                                              ║
 * ║  NOT incremented:                                                            ║
 * ║    Simple return / throw / variable declarations                            ║
 * ║    Type annotations, import/export statements                               ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import * as ts from "typescript";

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Cognitive Complexity for a TypeScript source string.
 * Parses to AST internally; call `cognitiveComplexityForNode` when you already
 * have a ts.Node (avoids re-parsing).
 */
export function cognitiveComplexityExact(
  src: string,
  fileName = "__astra__.ts",
): number {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  return cognitiveComplexityForNode(sf);
}

/**
 * Weighted variant: apply a structural multiplier to nesting increments.
 * Returns a larger score when `structuralMultiplier` > 1.
 */
export function cognitiveComplexityWeighted(
  src: string,
  structuralMultiplier = 1,
  fileName = "__astra__.ts",
): number {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const counter = new CognitiveComplexityCounter(structuralMultiplier);
  counter.visit(sf, 0);
  return counter.score;
}

/**
 * Compute Cognitive Complexity for an already-parsed ts.Node.
 * Pass the SourceFile or any sub-node.
 */
export function cognitiveComplexityForNode(node: ts.Node): number {
  const counter = new CognitiveComplexityCounter();
  counter.visit(node, 0);
  return counter.score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal counter
// ─────────────────────────────────────────────────────────────────────────────

class CognitiveComplexityCounter {
  score = 0;
  private multiplier: number;
  constructor(multiplier = 1) {
    this.multiplier = multiplier;
  }

  /**
   * Recursively visit a node.
   * @param node      Current AST node
   * @param nesting   Current structural nesting depth (0 = top level)
   */
  visit(node: ts.Node, nesting: number): void {
    switch (node.kind) {
      // ── Control flow — structural (nesting multiplier applies) ────────

      case ts.SyntaxKind.IfStatement: {
        const ifNode = node as ts.IfStatement;
        this._increment(nesting); // if
        this.visit(ifNode.expression, nesting); // condition
        this.visit(ifNode.thenStatement, nesting + 1); // body (deeper)
        if (ifNode.elseStatement) {
          // else / else if — flat increment for the else keyword itself
          this.score += 1;
          const elseBody = ifNode.elseStatement;
          // else if does NOT increase nesting beyond the outer if
          const innerNesting = ts.isIfStatement(elseBody)
            ? nesting
            : nesting + 1;
          this.visit(elseBody, innerNesting);
        }
        return;
      }

      case ts.SyntaxKind.ConditionalExpression: {
        // ternary a ? b : c
        const ternary = node as ts.ConditionalExpression;
        this._increment(nesting);
        this.visit(ternary.condition, nesting);
        this.visit(ternary.whenTrue, nesting + 1);
        this.visit(ternary.whenFalse, nesting + 1);
        return;
      }

      case ts.SyntaxKind.SwitchStatement: {
        const sw = node as ts.SwitchStatement;
        this._increment(nesting);
        this.visit(sw.expression, nesting);
        this.visit(sw.caseBlock, nesting + 1);
        return;
      }

      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement: {
        this._increment(nesting);
        ts.forEachChild(node, (child) => this.visit(child, nesting + 1));
        return;
      }

      case ts.SyntaxKind.CatchClause: {
        this._increment(nesting);
        ts.forEachChild(node, (child) => this.visit(child, nesting + 1));
        return;
      }

      // ── Break / continue with label — flat increment ───────────────────

      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement: {
        const stmt = node as ts.BreakOrContinueStatement;
        if (stmt.label) {
          // break <label> / continue <label> — adds complexity
          this.score += 1;
        }
        return;
      }

      // ── Nested functions — increase nesting, increment for the nesting ─

      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.Constructor:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor: {
        // Only increment nesting for NESTED functions (nesting > 0)
        // Top-level functions are the unit being measured — no increment
        const innerNesting = nesting > 0 ? nesting + 1 : 0;
        if (nesting > 0) {
          this._increment(nesting); // nested function itself adds complexity
        }
        ts.forEachChild(node, (child) => this.visit(child, innerNesting));
        return;
      }

      // ── Boolean binary expressions — flat, but sequence counts once ────

      case ts.SyntaxKind.BinaryExpression: {
        const bin = node as ts.BinaryExpression;
        const op = bin.operatorToken.kind;

        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          // Count this operator only if the parent is NOT the same operator
          // (avoids double-counting `a && b && c` as 2 when it's one sequence)
          const parent = bin.parent;
          const parentOp = ts.isBinaryExpression(parent)
            ? parent.operatorToken.kind
            : -1;

          if (parentOp !== op) {
            // Start of a new sequence
            this.score += 1;
          }
        }

        // Visit both sides
        this.visit(bin.left, nesting);
        this.visit(bin.right, nesting);
        return;
      }

      // ── LogicalNot — counted in source but only when it wraps expressions ─

      case ts.SyntaxKind.PrefixUnaryExpression: {
        const prefix = node as ts.PrefixUnaryExpression;
        // ! operator only when it's negating a complex expression (not a simple bool)
        if (
          prefix.operator === ts.SyntaxKind.ExclamationToken &&
          !ts.isIdentifier(prefix.operand) &&
          !ts.isLiteralExpression(prefix.operand)
        ) {
          this.score += 1;
        }
        this.visit(prefix.operand, nesting);
        return;
      }

      // ── Default: recurse with same nesting ────────────────────────────

      default:
        ts.forEachChild(node, (child) => this.visit(child, nesting));
        return;
    }
  }

  /** Structural increment: score += 1 + current nesting depth */
  private _increment(nesting: number): void {
    this.score += (1 + nesting) * this.multiplier;
  }
}
