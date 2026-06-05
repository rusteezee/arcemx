"use client";

import { motion, AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

export function PageTransition({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <AnimatePresence mode="wait" initial={true}>
      <motion.div
        key={path}
        initial={{ opacity: 0, y: 18, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
        transition={{
          duration: 0.45,
          ease: [0.22, 1, 0.36, 1], // ease-out-expo-like
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
