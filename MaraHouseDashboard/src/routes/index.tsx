import { createFileRoute } from "@tanstack/react-router";
import TillflowSite from "../components/TillflowSite";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TillFlow — Restaurant POS & M-Pesa Payments" },
      { name: "description", content: "TillFlow connects restaurant tables, orders, M-Pesa payments and daily operations in one considered system." },
      { property: "og:title", content: "TillFlow — Restaurant POS & M-Pesa Payments" },
      { property: "og:description", content: "From table to payment confirmation, see TillFlow at work inside Mara House, Nairobi." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return <TillflowSite />;
}
