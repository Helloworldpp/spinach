import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const previewImage = new URL("/og.png", base).toString();

  return {
    metadataBase: base,
    title: "一杆定胜负｜好友台球下注簿",
    description:
      "记录好友台球对决的胜负预测与精确比分，支持封盘、赛果结算和往期账簿。",
    applicationName: "一杆定胜负",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "一杆定胜负",
      description: "好友台球下注簿 · 胜负局与猜比分",
      type: "website",
      locale: "zh_CN",
      images: [
        {
          url: previewImage,
          width: 1672,
          height: 941,
          alt: "一杆定胜负，好友台球下注簿",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "一杆定胜负",
      description: "好友台球下注簿 · 胜负局与猜比分",
      images: [previewImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
