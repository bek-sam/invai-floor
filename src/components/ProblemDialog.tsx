import { BigButton, Dialog, DialogContent, DialogTitle } from "@invai/ui";
import { useTranslation } from "react-i18next";
import type { ReprintReason } from "../api/types";
import { useScan } from "../scanner/useWedgeScanner";

/** The six floor reasons, mapped onto the contract's reprint reasons. */
export const FLOOR_REASONS: { key: string; reason: ReprintReason; note: string | null }[] = [
  { key: "misprint", reason: "misprint", note: null },
  { key: "wrong_placement", reason: "wrong_placement", note: null },
  { key: "stain", reason: "blank_damaged", note: "stain" },
  { key: "peel", reason: "peel", note: null },
  { key: "wrong_blank", reason: "wrong_blank", note: null },
  { key: "other", reason: "other", note: null },
];

/** Big reason buttons; scans are swallowed while it is open so nothing happens underneath. */
export function ReasonDialog({
  open,
  title,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  onPick: (r: (typeof FLOOR_REASONS)[number]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useScan(() => {}, open);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl p-8">
        <DialogTitle className="text-3xl">{title}</DialogTitle>
        <div className="mt-4 grid grid-cols-3 gap-4">
          {FLOOR_REASONS.map((r) => (
            <BigButton
              key={r.key}
              variant="outline"
              className="h-28 whitespace-normal"
              onClick={() => onPick(r)}
            >
              {t(`floor.reason.${r.key}`)}
            </BigButton>
          ))}
        </div>
        <BigButton variant="ghost" className="mt-2" onClick={onClose}>
          {t("floor.common.cancel")}
        </BigButton>
      </DialogContent>
    </Dialog>
  );
}
