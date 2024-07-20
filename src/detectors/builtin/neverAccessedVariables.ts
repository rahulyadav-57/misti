import { ASTStatement, ASTRef } from "@tact-lang/compiler/dist/grammar/ast";
import { WorklistSolver } from "../../internals/solver/";
import { Transfer } from "../../internals/transfer";
import { Detector } from "../detector";
import { JoinSemilattice } from "../../internals/lattice";
import { MistiContext } from "../../internals/context";
import { CompilationUnit, Node, CFG } from "../../internals/ir";
import { createError, MistiTactError, Severity } from "../../internals/errors";
import { forEachExpression } from "../../internals/tactASTUtil";

type FieldName = string;
type ConstantName = string;

interface VariableState {
  declared: Set<[string, ASTRef]>;
  used: Set<string>;
}

/**
 * A powerset lattice that keeps state of local varialbes within control flow.
 */
class VariableUsageLattice implements JoinSemilattice<VariableState> {
  bottom(): VariableState {
    return { declared: new Set(), used: new Set() };
  }

  join(a: VariableState, b: VariableState): VariableState {
    const joinedDeclared = new Set([...a.declared, ...b.declared]);
    const joinedUsed = new Set([...a.used, ...b.used]);
    return { declared: joinedDeclared, used: joinedUsed };
  }

  leq(a: VariableState, b: VariableState): boolean {
    return (
      [...a.declared].every((x) => b.declared.has(x)) &&
      [...a.used].every((x) => b.used.has(x))
    );
  }
}

class NeverAccessedTransfer implements Transfer<VariableState> {
  public transfer(
    inState: VariableState,
    _node: Node,
    stmt: ASTStatement,
  ): VariableState {
    const outState = { ...inState };
    if (stmt.kind === "statement_let") {
      outState.declared.add([stmt.name, stmt.ref]);
    } else {
      forEachExpression(stmt, (expr) => {
        if (expr.kind === "id") {
          outState.used.add(expr.value);
        }
      });
    }
    return outState;
  }
}

/**
 * A detector that identifies write-only or unused variables, fields and constants.
 *
 * ## Why is it bad?
 * These variables are either assigned but never used in any meaningful computation,
 * or they are declared and never used at all, which may indicate redundant code
 * or an incomplete implementation of the intended logic.
 *
 * ## Example
 * ```tact
 * // Error: the developer forgot to use the constant
 * const MAX_SUPPLY: Int = 1000;
 *
 * fun mint(to: Address, amount: Int) {
 *   balances.set(to, balances.get(to)!! + amount);
 *   totalSupply += amount;
 * }
 * ```
 *
 * Use instead:
 * ```tact
 * const MAX_SUPPLY: Int = 1000;
 *
 * fun mint(to: Address, amount: Int) {
 *   // OK: Fixed after the linter highlighted this warning
 *   require(totalSupply + amount <= MAX_SUPPLY, "Exceeds max supply");
 *   balances.set(to, balances.get(to)!! + amount);
 *   totalSupply += amount;
 * }
 * ```
 */
export class NeverAccessedVariables extends Detector {
  check(_ctx: MistiContext, cu: CompilationUnit): MistiTactError[] {
    return [
      ...this.checkFields(cu),
      ...this.checkConstants(cu),
      ...this.checkVariables(cu),
    ];
  }

  checkFields(cu: CompilationUnit): MistiTactError[] {
    const definedFields = this.collectDefinedFields(cu);
    const usedFields = this.collectUsedFields(cu);
    return Array.from(
      new Set(
        [...definedFields].filter(([name, _ref]) => !usedFields.has(name)),
      ),
    ).map(([name, ref]) =>
      createError(`Field ${name} is never used`, Severity.MEDIUM, ref),
    );
  }

  collectDefinedFields(cu: CompilationUnit): Set<[FieldName, ASTRef]> {
    return Array.from(cu.ast.getContracts()).reduce((acc, contract) => {
      contract.declarations.forEach((decl) => {
        if (decl.kind === "def_field") {
          acc.add([decl.name, decl.ref]);
        }
      });
      return acc;
    }, new Set<[FieldName, ASTRef]>());
  }

  collectUsedFields(cu: CompilationUnit): Set<FieldName> {
    return Array.from(cu.ast.getFunctions()).reduce((acc, fun) => {
      forEachExpression(fun, (expr) => {
        if (expr.kind === "op_field" && expr.src.kind === "id") {
          acc.add(expr.src.value);
        }
      });
      return acc;
    }, new Set<FieldName>());
  }

  checkConstants(cu: CompilationUnit): MistiTactError[] {
    const definedConstants = this.collectDefinedConstants(cu);
    const usedConstants = this.collectUsedNames(cu);
    return Array.from(
      new Set(
        [...definedConstants].filter(
          ([name, _ref]) => !usedConstants.has(name),
        ),
      ),
    ).map(([name, ref]) =>
      createError(`Constant ${name} is never used`, Severity.MEDIUM, ref),
    );
  }

  collectDefinedConstants(cu: CompilationUnit): Set<[ConstantName, ASTRef]> {
    return Array.from(cu.ast.getConstants(false)).reduce((acc, constant) => {
      acc.add([constant.name, constant.ref]);
      return acc;
    }, new Set<[ConstantName, ASTRef]>());
  }

  /**
   * Collects all the identifiers using withing all the statements.
   */
  collectUsedNames(cu: CompilationUnit): Set<ConstantName> {
    return Array.from(cu.ast.getStatements()).reduce((acc, stmt) => {
      forEachExpression(stmt, (expr) => {
        if (expr.kind === "id") {
          acc.add(expr.value);
        }
      });
      return acc;
    }, new Set<FieldName>());
  }

  /**
   * Checks never accessed local variables in all the functions leveraging the
   * monotonic framework and the fixpoint dataflow solver.
   */
  checkVariables(cu: CompilationUnit): MistiTactError[] {
    const errors: MistiTactError[] = [];
    cu.forEachCFG(cu.ast, (cfg: CFG, _node: Node, _stmt: ASTStatement) => {
      if (cfg.origin === "stdlib") {
        return;
      }
      const lattice = new VariableUsageLattice();
      const transfer = new NeverAccessedTransfer();
      const solver = new WorklistSolver(cu, cfg, transfer, lattice);
      const results = solver.solve();

      const declaredVariables = new Map<string, ASTRef>();
      const usedVariables = new Set<string>();
      results.getStates().forEach((state, nodeIdx) => {
        if (!cfg.getNode(nodeIdx)!.isExit()) {
          return;
        }
        state.declared.forEach(([name, ref]) =>
          declaredVariables.set(name, ref),
        );
        state.used.forEach((name) => usedVariables.add(name));
      });
      Array.from(declaredVariables.keys()).forEach((name) => {
        if (!usedVariables.has(name)) {
          errors.push(
            createError(
              `Variable ${name} is never accessed`,
              Severity.MEDIUM,
              declaredVariables.get(name)!,
            ),
          );
        }
      });
    });

    return errors;
  }
}
