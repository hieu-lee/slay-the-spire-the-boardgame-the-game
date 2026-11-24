import { useEffect, type RefObject } from 'react'

/** Keeps a native `<dialog>` synchronized with a boolean open condition via showModal/close. */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  instanceKey?: unknown,
) {
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [ref, open, instanceKey])
}
