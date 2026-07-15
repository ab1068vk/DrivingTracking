import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";
import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** @type {React.ForwardRefExoticComponent<any>} */
const Button = React.forwardRef((propsArg, ref) => {
  const {
    className = "",
    variant = "default",
    size = "default",
    asChild = false,
    loading = false,
    loadingText = "Working...",
    children,
    disabled,
    onClick,
    ...props
  } = /** @type {any} */ (propsArg);
  const isUnavailable = disabled || loading;

  if (asChild) {
    const child = React.Children.only(children);
    const childContent = loading ? (
      <>
        <LoaderCircle className="animate-spin" aria-hidden="true" />
        {loadingText}
      </>
    ) : child.props.children;
    return (
      <Slot
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        aria-disabled={isUnavailable ? true : undefined}
        aria-busy={loading || undefined}
        data-loading={loading ? 'true' : undefined}
        onClick={isUnavailable
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          : onClick}
        {...props}
      >
        {React.cloneElement(child, undefined, childContent)}
      </Slot>
    );
  }

  const Comp = "button"
  return (
    (<Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      disabled={isUnavailable}
      aria-busy={loading || undefined}
      data-loading={loading ? 'true' : undefined}
      onClick={onClick}
      {...props}>
      {loading && <LoaderCircle className="animate-spin" aria-hidden="true" />}
      {loading ? loadingText : children}
    </Comp>)
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
