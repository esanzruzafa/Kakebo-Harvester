import type { RawCleanupWarning } from "../storage/account-removal.js";

export function formatRawCleanupWarnings(
  warnings: RawCleanupWarning[],
  translate: (key: string, fallback: string) => string
): string {
  return warnings
    .map((warning) => {
      const details: Record<RawCleanupWarning, { key: string; fallback: string }> = {
        ambiguous: {
          key: "warning.rawCleanup.ambiguous",
          fallback: "Raw data was retained because its file type could not be verified."
        },
        "cleanup-failed": {
          key: "warning.rawCleanup.failed",
          fallback: "Raw data could not be removed."
        },
        missing: {
          key: "warning.rawCleanup.missing",
          fallback: "The raw data file was already missing."
        },
        "outside-root": {
          key: "warning.rawCleanup.outsideRoot",
          fallback: "Raw data outside the configured data directory was retained."
        },
        shared: {
          key: "warning.rawCleanup.shared",
          fallback: "Raw data shared by another local record was retained."
        },
        "symbolic-link": {
          key: "warning.rawCleanup.symbolicLink",
          fallback: "Raw data was retained because a symbolic link was detected."
        }
      };
      const detail = details[warning];
      return translate(detail.key, detail.fallback);
    })
    .join(" · ");
}
