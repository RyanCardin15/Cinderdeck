import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export const PRODUCT_SIDEBAR_STORAGE_KEY = "cinderdeck.product-sidebar";
export const PRODUCT_SIDEBAR_DEFAULT_WIDTH = 260;
export const PRODUCT_SIDEBAR_MIN_WIDTH = 210;
export const PRODUCT_SIDEBAR_MAX_WIDTH = 420;
export const PRODUCT_SIDEBAR_COLLAPSED_WIDTH = 60;

export function clampProductSidebarWidth(width: number, viewportWidth: number) {
  return Math.max(
    PRODUCT_SIDEBAR_MIN_WIDTH,
    Math.min(width, PRODUCT_SIDEBAR_MAX_WIDTH, viewportWidth - 360),
  );
}

function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(PRODUCT_SIDEBAR_STORAGE_KEY) ?? "null");
    return {
      width:
        typeof value?.width === "number" && Number.isFinite(value.width)
          ? Math.max(PRODUCT_SIDEBAR_MIN_WIDTH, Math.min(value.width, PRODUCT_SIDEBAR_MAX_WIDTH))
          : PRODUCT_SIDEBAR_DEFAULT_WIDTH,
      collapsed: value?.collapsed === true,
    };
  } catch {
    return { width: PRODUCT_SIDEBAR_DEFAULT_WIDTH, collapsed: false };
  }
}

const ProductSidebarContext = createContext({
  width: PRODUCT_SIDEBAR_DEFAULT_WIDTH,
  collapsed: false,
  readScrollTop: (): number => 0,
  rememberScrollTop: (_value: number) => {},
  resize: (_width: number): number => PRODUCT_SIDEBAR_DEFAULT_WIDTH,
  toggle: () => {},
  reset: () => {},
});

export const useProductSidebar = () => useContext(ProductSidebarContext);

/** One preference owner survives navigation between every main-app surface. */
export function ProductSidebarLayout({ children }: { children: ReactNode }) {
  const scrollPosition = useRef(0);
  const readScrollTop = useCallback(() => scrollPosition.current, []);
  const rememberScrollTop = useCallback((value: number) => {
    scrollPosition.current = value;
  }, []);
  const [preferences, setPreferences] = useState(readPreferences);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(PRODUCT_SIDEBAR_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Preferences still work for this session when storage is unavailable.
    }
  }, [preferences]);
  const width = clampProductSidebarWidth(preferences.width, viewportWidth);
  const value = useMemo(
    () => ({
      width,
      collapsed: preferences.collapsed,
      readScrollTop,
      rememberScrollTop,
      resize: (nextWidth: number) => {
        const next = clampProductSidebarWidth(nextWidth, window.innerWidth);
        setPreferences((current) =>
          current.width === next ? current : { ...current, width: next },
        );
        return next;
      },
      toggle: () => setPreferences((current) => ({ ...current, collapsed: !current.collapsed })),
      reset: () =>
        setPreferences((current) => ({ ...current, width: PRODUCT_SIDEBAR_DEFAULT_WIDTH })),
    }),
    [width, preferences.collapsed, readScrollTop, rememberScrollTop],
  );
  return (
    <ProductSidebarContext.Provider value={value}>
      <div
        style={
          {
            display: "contents",
            "--product-sidebar-width": `${preferences.collapsed ? PRODUCT_SIDEBAR_COLLAPSED_WIDTH : width}px`,
            // Define the grid track here too: an inherited root var() has already
            // resolved its fallback before the saved width exists on this owner.
            "--deck-rail-width": `${preferences.collapsed ? PRODUCT_SIDEBAR_COLLAPSED_WIDTH : width}px`,
          } as CSSProperties
        }
      >
        {children}
      </div>
    </ProductSidebarContext.Provider>
  );
}
