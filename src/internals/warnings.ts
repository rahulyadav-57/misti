import { MistiContext } from "./context";
import { InternalException } from "./exceptions";
import { SrcInfo } from "@tact-lang/compiler/dist/grammar/ast";
import * as path from "path";

/**
 * Enumerates the levels of severity that can be assigned to detected findings.
 */
export enum Severity {
  INFO,
  LOW,
  MEDIUM,
  HIGH,
  CRITICAL,
}

/**
 * Returns string representation of `Severity` optionally wrapped in ANSI escape
 * sequences making them colorful for visual overload.
 */
export function severityToString(
  s: Severity,
  { colorize = false }: Partial<{ colorize: boolean }>,
): string {
  const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    low: "\x1b[32m", // Green
    medium: "\x1b[33m", // Yellow
    high: "\x1b[31m", // Red
    critical: "\x1b[35m", // Magenta
  };
  switch (s) {
    case Severity.INFO:
      return colorize ? `${colors.bold}[INFO]${colors.reset}` : "[INFO]";
    case Severity.LOW:
      return colorize
        ? `${colors.bold}${colors.low}[LOW]${colors.reset}`
        : "[LOW]";
    case Severity.MEDIUM:
      return colorize
        ? `${colors.bold}${colors.medium}[MEDIUM]${colors.reset}`
        : "[MEDIUM]";
    case Severity.HIGH:
      return colorize
        ? `${colors.bold}${colors.high}[HIGH]${colors.reset}`
        : "[HIGH]";
    case Severity.CRITICAL:
      return colorize
        ? `${colors.bold}${colors.critical}[CRITICAL]${colors.reset}`
        : "[CRITICAL]";
  }
}

/**
 * Base URL to detectors documentation.
 */
export const BASE_DOC_URL = "https://nowarp.io/tools/misti/docs/detectors";

/**
 * Misti warning that highlights a specific place in a Tact contract.
 */
export class MistiTactWarning {
  /**
   * @param detectorId Unique identifier of the detector raised that warning.
   */
  constructor(
    public readonly detectorId: string,
    public readonly msg: string,
    public readonly loc: SrcInfo,
    public readonly severity: Severity,
  ) {
    this.loc = loc;
  }

  /**
   * Constructs a warning object with a description and the source code location.
   *
   * @param description Descriptive text of the warning.
   * @param detectorId Unique identifier of the detector.
   * @param severity Severity of the finding.
   * @param loc Reference to the source code that includes file information and position data.
   * @param data Additional optional data for the warning, including:
   * - `extraDescription`: More comprehensive description that clarifies the warning in greater detail.
   * - `docURL`: URL to the detector documentation.
   * - `suggestion`: Suggested change in the source code.
   * @returns A new MistiTactWarning containing the warning message and source code reference.
   */
  public static make(
    ctx: MistiContext,
    detectorId: string,
    description: string,
    severity: Severity,
    loc: SrcInfo,
    data: Partial<{
      extraDescription: string;
      docURL: string;
      suggestion: string;
    }> = {},
  ): MistiTactWarning | never {
    if (description.length === 0) {
      throw InternalException.make("description cannot be empty");
    }
    const {
      extraDescription = undefined,
      docURL = undefined,
      suggestion = undefined,
    } = data;
    const pos = loc.file
      ? (() => {
          const lc = loc.interval.getLineAndColumn() as {
            lineNum: number;
            colNum: number;
          };
          const lcStr = `${lc}`;
          const lcLines = lcStr.split("\n");
          lcLines.shift();
          const contractPath =
            ctx.singleContractPath !== undefined
              ? ctx.singleContractPath
              : loc.file;
          const shownPath = path.relative(process.cwd(), contractPath);
          return `${shownPath}:${lc.lineNum}:${lc.colNum}:\n${lcLines.join("\n")}`;
        })()
      : "";
    const extraDescriptionStr =
      extraDescription === undefined ? "" : extraDescription + "\n";
    const suggestionStr = suggestion === undefined ? "" : `Help: ${suggestion}`;
    const docURLStr = docURL === undefined ? "" : `\nSee: ${docURL}`;
    const msg = [
      description,
      "\n",
      pos,
      extraDescriptionStr,
      suggestionStr,
      docURLStr,
    ].join("");
    return new MistiTactWarning(detectorId, msg, loc, severity);
  }
}

/**
 * Creates a link to the documentation for built-in detectors.
 */
export function makeDocURL(detectorName: string): string {
  return `${BASE_DOC_URL}/${detectorName}`;
}
