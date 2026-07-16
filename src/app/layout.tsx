import type { Metadata } from "next";
import { Anton, Archivo, Inter } from "next/font/google";
import { SafeArea } from "@coinbase/onchainkit/minikit";
import { Analytics } from "@vercel/analytics/next";
import { minikitConfig } from "@/lib/minikit.config";
import { RootProvider } from "./providers";
import "./globals.css";

const anton = Anton({
  weight: "400",
  variable: "--font-anton",
  subsets: ["latin"],
});

const archivo = Archivo({
  weight: ["600", "700", "800", "900"],
  variable: "--font-archivo",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { name, description, version, homeUrl } = minikitConfig.miniapp;
  const rootUrl =
    process.env.NEXT_PUBLIC_URL ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    "http://localhost:3000";

  const embed = {
    version,
    imageUrl: `${rootUrl}/hero-v7.png`,
    button: {
      title: `Launch ${name}`,
      action: {
        type: "launch_miniapp",
        name,
        url: homeUrl,
        splashImageUrl: `${rootUrl}/splash-v5.png`,
        splashBackgroundColor: "#faf8f2",
      },
    },
  };

  return {
    title: name,
    description,
    openGraph: {
      title: `${name} — powered by Megapot`,
      description: `Gift and buy $1 lottery tickets on Base. Daily drawings, real prizes.`,
      images: [`${rootUrl}/hero-v7.png`],
    },
    other: {
      "fc:miniapp": JSON.stringify(embed),
      "fc:frame": JSON.stringify({
        ...embed,
        button: {
          ...embed.button,
          action: { ...embed.button.action, type: "launch_frame" },
        },
      }),
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <RootProvider>
      <html lang="en" className={`${anton.variable} ${archivo.variable} ${inter.variable}`}>
        <body className="min-h-screen flex flex-col antialiased">
          <SafeArea>{children}</SafeArea>
          <Analytics />
        </body>
      </html>
    </RootProvider>
  );
}
