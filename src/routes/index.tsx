import { createFileRoute } from "@tanstack/react-router";
import NestingApp from "@/components/NestingApp";

export const Route = createFileRoute("/")({
  component: NestingApp,
});
