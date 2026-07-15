"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

/** @type {React.ForwardRefExoticComponent<any>} */
const DialogOverlay = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-50 bg-slate-950/60 will-change-opacity data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props} />
  );
})
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
const DialogContent = React.forwardRef((propsArg, ref) => {
  const { className = "", children = null, ...props } = /** @type {any} */ (propsArg);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-app-dialog-content="true"
        className={cn(
          "fixed left-[50%] top-[50%] z-[51] grid max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto overscroll-contain border bg-background p-4 shadow-2xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:w-[calc(100%-2rem)] sm:p-6 sm:rounded-lg",
          className
        )}
        {...props}>
        {children}
        <DialogPrimitive.Close
          data-app-dialog-close="true"
          className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-lg opacity-70 ring-offset-background transition-opacity hover:bg-accent hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none sm:right-3 sm:top-3 data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className = "",
  ...props
}) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
    {...props} />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className = "",
  ...props
}) => (
  <div
    className={cn("flex flex-col-reverse gap-2 [&>button]:min-h-11 [&>button]:w-full sm:flex-row sm:justify-end sm:[&>button]:w-auto", className)}
    {...props} />
)
DialogFooter.displayName = "DialogFooter"

/** @type {React.ForwardRefExoticComponent<any>} */
const DialogTitle = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props} />
  );
})
DialogTitle.displayName = DialogPrimitive.Title.displayName

/** @type {React.ForwardRefExoticComponent<any>} */
const DialogDescription = React.forwardRef((propsArg, ref) => {
  const { className = "", ...props } = /** @type {any} */ (propsArg);
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("text-sm text-muted-foreground", className)}
      {...props} />
  );
})
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
