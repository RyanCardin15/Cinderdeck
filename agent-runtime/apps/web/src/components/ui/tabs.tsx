"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "~/lib/utils";

/**
 * Underlined section tabs. Inactive panels unmount, so content that is
 * expensive to load (a long list, a probe) only runs once its tab is opened.
 */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex min-w-0 flex-col gap-5", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex min-w-0 items-end gap-5 overflow-x-auto border-b border-border/60 px-3 sm:px-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "-mb-px inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent text-sm whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline data-active:border-foreground data-active:text-foreground data-disabled:cursor-default data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** A quiet count beside a tab label, e.g. the number of models. */
function TabsCount({ children }: { readonly children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs leading-4.5 text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("min-w-0 space-y-6 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsCount, TabsList, TabsPanel, TabsTab };
