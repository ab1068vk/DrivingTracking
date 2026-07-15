import * as React from "react"
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

const AlertDialog = AlertDialogPrimitive.Root

const AlertDialogTrigger = AlertDialogPrimitive.Trigger

const AlertDialogPortal = AlertDialogPrimitive.Portal

/** @type {React.ForwardRefExoticComponent<any>} */
const AlertDialogOverlay = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <AlertDialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-slate-950/60 will-change-opacity data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
      ref={ref} />
  );
})
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
const AlertDialogContent = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={ref}
        data-app-dialog-content="true"
        className={cn(
          "fixed left-[50%] top-[50%] z-[51] grid max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto overscroll-contain border bg-background p-4 shadow-2xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:w-[calc(100%-2rem)] sm:p-6 sm:rounded-lg",
          className
        )}
        {...props} />
    </AlertDialogPortal>
  );
})
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName

const AlertDialogHeader = ({
  className = "",
  ...props
}) => (
  <div
    className={cn("flex flex-col space-y-2 text-center sm:text-left", className)}
    {...props} />
)
AlertDialogHeader.displayName = "AlertDialogHeader"

const AlertDialogFooter = ({
  className = "",
  ...props
}) => (
  <div
    className={cn("flex flex-col-reverse gap-2 [&>button]:min-h-11 [&>button]:w-full sm:flex-row sm:justify-end sm:[&>button]:w-auto", className)}
    {...props} />
)
AlertDialogFooter.displayName = "AlertDialogFooter"

/** @type {React.ForwardRefExoticComponent<any>} */
const AlertDialogTitle = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return <AlertDialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />;
})
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
const AlertDialogDescription = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <AlertDialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props} />
  );
})
AlertDialogDescription.displayName =
  AlertDialogPrimitive.Description.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
const AlertDialogAction = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return <AlertDialogPrimitive.Action ref={ref} className={cn(buttonVariants(), className)} {...props} />;
})
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
const AlertDialogCancel = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <AlertDialogPrimitive.Cancel
      ref={ref}
      className={cn(buttonVariants({ variant: "outline" }), "mt-2 sm:mt-0", className)}
      {...props} />
  );
})
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
