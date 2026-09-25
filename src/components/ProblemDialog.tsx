import { REPRINT_REASONS } from "@invai/contracts";
import { BigButton, Dialog, DialogContent, DialogTitle } from "@invai/ui";
import { useTranslation } from "react-i18next";
import type { ReprintReason } from "../api/types";
import { useScan } from "../scanner/useWedgeScanner";

/** Every reprint reason the contract knows, in its order; the labels are floor.reason.<key>. */
export const FLOOR_REASONS: { key: ReprintReason; reason: ReprintReason; note: string | null }[] =
  REPRINT_REASONS.map((reason) => ({ key: reason, reason, note: null }));

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
      <DialogContent className="max-w-5xl p-8">
        <DialogTitle className="text-3xl">{title}</DialogTitle>
        <div className="mt-4 grid grid-cols-4 gap-3">
          {FLOOR_REASONS.map((r) => (
            <BigButton
              key={r.key}
              variant="outline"
              className="h-24 whitespace-normal text-2xl leading-tight"
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
