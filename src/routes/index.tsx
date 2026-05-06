import { createFileRoute } from "@tanstack/react-router";
import NestingApp from "@/components/NestingApp";

export const Route = createFileRoute("/")({
  component: NestingApp,
  head: () => ({
    meta: [
      { title: "NestCNC — Nesting automático para corte CNC" },
      {
        name: "description",
        content:
          "Importe PDFs vetoriais técnicos e execute nesting profissional para corte CNC, laser, plasma e marcenaria.",
      },
    ],
  }),
});
