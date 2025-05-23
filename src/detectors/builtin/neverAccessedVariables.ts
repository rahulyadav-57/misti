import { MistiContext } from "../../internals/context";
import { BasicBlock, Cfg, CompilationUnit } from "../../internals/ir";
import { JoinSemilattice } from "../../internals/lattice";
import { WorklistSolver } from "../../internals/solver/";
import {
  SrcInfoSet,
  extractPath,
  forEachExpression,
} from "../../internals/tact";
import {
  AstExpression,
  AstId,
  AstNode,
  AstStatement,
  AstTrait,
} from "../../internals/tact/imports";
import { idText, isSelfId } from "../../internals/tact/imports";
import { SrcInfo } from "../../internals/tact/imports";
import { Transfer } from "../../internals/transfer";
import { mergeSets, isSetSubsetOf } from "../../internals/util";
import { unreachable } from "../../internals/util";
import { Category, MistiTactWarning, Severity } from "../../internals/warnings";
import { DataflowDetector, WarningsBehavior } from "../detector";

type FieldName = string;
type ConstantName = string;
type VariableName = string;

interface VariableState {
  declared: SrcInfoSet<string>;
  // The variable identifier was accessed in any expression
  accessed: Set<VariableName>;
  // The variable value was reassigned
  written: Set<VariableName>;
}

/**
 * A powerset lattice that keeps state of local variables within control flow.
 */
class VariableUsageLattice implements JoinSemilattice<VariableState> {
  bottom(): VariableState {
    return {
      declared: new SrcInfoSet<string>(),
      accessed: new Set(),
      written: new Set(),
    };
  }

  join(a: VariableState, b: VariableState): VariableState {
    const declared = new SrcInfoSet<string>([
      ...a.declared.extract(),
      ...b.declared.extract(),
    ]);
    const accessed = mergeSets(a.accessed, b.accessed);
    const written = mergeSets(a.written, b.written);
    return { declared, accessed, written };
  }

  leq(a: VariableState, b: VariableState): boolean {
    return (
      [...a.declared.extract()].every((x) => b.declared.has(x)) &&
      isSetSubsetOf(a.accessed, b.accessed) &&
      isSetSubsetOf(a.written, b.written)
    );
  }
}

class NeverAccessedTransfer implements Transfer<VariableState> {
  public transfer(
    inState: VariableState,
    _node: BasicBlock,
    stmt: AstStatement,
  ): VariableState {
    const outState = {
      declared: inState.declared,
      accessed: inState.accessed,
      written: inState.written,
    };
    this.processStatements(outState, stmt);
    return outState;
  }

  private processStatements(outState: VariableState, stmt: AstStatement): void {
    const trackAccess = (node: AstStatement | AstExpression) => {
      forEachExpression(node, (expr) => {
        if (expr.kind === "id") {
          outState.accessed.add(idText(expr));
        }
      });
    };
    switch (stmt.kind) {
      case "statement_let":
        outState.declared.add([stmt.name.text, stmt.loc]);
        trackAccess(stmt.expression);
        break;
      case "statement_destruct":
        for (const [, ids] of stmt.identifiers) {
          outState.declared.add([idText(ids[1]), stmt.loc]);
        }
        trackAccess(stmt.expression);
        break;
      case "statement_return":
        if (stmt.expression) trackAccess(stmt.expression);
        break;
      case "statement_expression":
        trackAccess(stmt.expression);
        break;
      case "statement_assign":
      case "statement_augmentedassign":
        const name = extractPath(stmt.path);
        outState.written.add(name);
        trackAccess(stmt.expression);
        break;
      case "statement_condition":
        trackAccess(stmt.condition);
        stmt.trueStatements.forEach((s) => this.processStatements(outState, s));
        if (stmt.falseStatements !== undefined)
          stmt.falseStatements.forEach((s) =>
            this.processStatements(outState, s),
          );
        break;
      case "statement_while":
      case "statement_until":
        trackAccess(stmt.condition);
        stmt.statements.forEach((s) => this.processStatements(outState, s));
        break;
      case "statement_repeat":
        trackAccess(stmt.iterations);
        stmt.statements.forEach((s) => this.processStatements(outState, s));
        break;
      case "statement_try":
        stmt.statements.forEach((s) => this.processStatements(outState, s));
        if (stmt.catchBlock) {
          stmt.catchBlock.catchStatements.forEach((s) =>
            this.processStatements(outState, s),
          );
        }
        break;
      case "statement_foreach":
        trackAccess(stmt.map);
        stmt.statements.forEach((s) => this.processStatements(outState, s));
        break;
      case "statement_block":
        // TODO: https://github.com/nowarp/misti/issues/41
        break;
      default:
        unreachable(stmt);
    }
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
 *   // OK: Fixed after the analyzer highlighted this warning
 *   require(totalSupply + amount <= MAX_SUPPLY, "Exceeds max supply");
 *   balances.set(to, balances.get(to)!! + amount);
 *   totalSupply += amount;
 * }
 * ```
 */
export class NeverAccessedVariables extends DataflowDetector {
  severity = Severity.MEDIUM;
  category = Category.SECURITY;

  async check(cu: CompilationUnit): Promise<MistiTactWarning[]> {
    return [
      ...this.checkFields(cu),
      ...this.checkConstants(cu),
      ...this.checkVariables(cu),
    ];
  }

  get shareImportedWarnings(): WarningsBehavior {
    // Never accessed constants/fields from imported files will be reported iff
    // they are reported in each of the projects (CompilationUnit).
    return "intersect";
  }

  checkFields(cu: CompilationUnit): MistiTactWarning[] {
    const defined = this.collectDefinedFields(cu);
    const used = this.collectUsedFields(cu);
    return Array.from(
      new Set([...defined].filter(([name, _ref]) => !used.has(name))),
    ).reduce((acc, [name, ref]) => {
      if (this.skipUnused(name)) {
        return acc;
      }
      const err = this.makeWarning(`Field ${name} is never used`, ref, {
        suggestion: "Consider removing the field",
      });
      acc.push(err);
      return acc;
    }, [] as MistiTactWarning[]);
  }

  private collectDefinedFields(cu: CompilationUnit): Set<[FieldName, SrcInfo]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getFields = (declarations: readonly any[]) =>
      declarations
        .filter((decl) => decl.kind === "field_decl")
        .map((decl) => [decl.name.text, decl.loc] as [FieldName, SrcInfo]);
    return Array.from(cu.ast.getContracts()).reduce((acc, contract) => {
      const contractFields = getFields(contract.declarations);
      acc = new Set([...acc, ...contractFields]);
      this.forEachTrait(this.ctx, cu, contract.traits, (trait) => {
        const traitFields = getFields(trait.declarations);
        acc = new Set([...acc, ...traitFields]);
      });
      return acc;
    }, new Set<[FieldName, SrcInfo]>());
  }

  /**
   * Executes `callback` for each trait available within the compilation unit `cu`.
   */
  private forEachTrait(
    ctx: MistiContext,
    cu: CompilationUnit,
    traitIds: readonly AstId[],
    callback: (trait: AstTrait) => void,
    visited: Set<number> = new Set<number>(),
  ): void {
    traitIds.forEach((traitId) => {
      const traitName = traitId.text;
      const trait = cu.ast.findTrait(traitName);
      if (trait === undefined) {
        ctx.logger.error(`Cannot access trait ${traitName}`);
        return;
      }
      if (visited.has(trait.id)) return;
      visited.add(trait.id);
      callback(trait);
      this.forEachTrait(ctx, cu, trait.traits, callback, visited);
    });
  }

  private collectUsedFields(cu: CompilationUnit): Set<FieldName> {
    const processExpressions = (fun: AstNode, acc: Set<FieldName>) => {
      forEachExpression(fun, (expr) => {
        if (
          expr.kind === "field_access" &&
          expr.aggregate.kind === "id" &&
          isSelfId(expr.aggregate)
        ) {
          acc.add(expr.field.text);
        }
      });
      return acc;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processDeclarations = (
      declarations: readonly any[],
      acc: Set<FieldName>,
    ) => {
      declarations.forEach((decl) => {
        if (
          decl.kind === "function_def" ||
          decl.kind === "receiver" ||
          decl.kind === "contract_init"
        ) {
          acc = processExpressions(decl, acc);
        }
      });
      return acc;
    };
    return Array.from(cu.ast.getContracts()).reduce((acc, contract) => {
      acc = processDeclarations(contract.declarations, acc);
      this.forEachTrait(this.ctx, cu, contract.traits, (trait) => {
        acc = processDeclarations(trait.declarations, acc);
      });
      return acc;
    }, new Set<FieldName>());
  }

  checkConstants(cu: CompilationUnit): MistiTactWarning[] {
    const definedConstants = this.collectDefinedConstants(cu);
    const usedConstants = this.collectUsedNames(cu);
    return Array.from(
      new Set(
        [...definedConstants].filter(
          ([name, _ref]) => !usedConstants.has(name),
        ),
      ),
    ).reduce((acc, [name, ref]) => {
      if (this.skipUnused(name)) {
        return acc;
      }
      const err = this.makeWarning(`Constant ${name} is never used`, ref, {
        suggestion: "Consider removing the constant",
      });
      acc.push(err);
      return acc;
    }, [] as MistiTactWarning[]);
  }

  collectDefinedConstants(cu: CompilationUnit): Set<[ConstantName, SrcInfo]> {
    return Array.from(cu.ast.getConstants({ includeContract: false })).reduce(
      (acc, constant) => {
        acc.add([constant.name.text, constant.loc]);
        return acc;
      },
      new Set<[ConstantName, SrcInfo]>(),
    );
  }

  /**
   * Collects all the identifiers using withing all the statements.
   */
  collectUsedNames(cu: CompilationUnit): Set<ConstantName> {
    return Array.from(cu.ast.getStatements()).reduce((acc, stmt) => {
      forEachExpression(stmt, (expr) => {
        if (expr.kind === "id") {
          acc.add(expr.text);
        }
      });
      return acc;
    }, new Set<FieldName>());
  }

  /**
   * Checks never accessed local variables in all the functions leveraging the
   * monotonic framework and the fixpoint dataflow solver.
   */
  checkVariables(cu: CompilationUnit): MistiTactWarning[] {
    const warnings: MistiTactWarning[] = [];
    const traversedFunctions = new Set<string>();
    cu.forEachCFG((cfg: Cfg) => {
      if (cfg.origin === "stdlib" || traversedFunctions.has(cfg.name)) {
        return;
      }
      traversedFunctions.add(cfg.name);
      const lattice = new VariableUsageLattice();
      const transfer = new NeverAccessedTransfer();
      const solver = new WorklistSolver(cu, cfg, transfer, lattice, "forward");
      const results = solver.solve();

      const declaredVariables = new Map<string, SrcInfo>();
      const accessedVariables = new Set<string>();
      const writtenVariables = new Set<string>();
      results.getStates().forEach((state, nodeIdx) => {
        if (!cfg.getBasicBlock(nodeIdx)!.isExit()) {
          return;
        }
        state.declared
          .extract()
          .forEach(([name, ref]) => declaredVariables.set(name, ref));
        state.accessed.forEach((name) => accessedVariables.add(name));
        state.written.forEach((name) => writtenVariables.add(name));
      });
      Array.from(declaredVariables.keys()).forEach((name) => {
        if (this.skipUnused(name)) {
          return;
        }
        const isWritten = writtenVariables.has(name);
        const isAccessed = accessedVariables.has(name);
        if (!isAccessed) {
          const msg = isWritten
            ? `Write-only variable: ${name}`
            : `Variable ${name} is never accessed`;
          const suggestion = isWritten
            ? "The variable value should be accessed"
            : "Consider removing the variable";
          warnings.push(
            this.makeWarning(msg, declaredVariables.get(name)!, {
              suggestion,
            }),
          );
        }
      });
    });

    return warnings;
  }
}
