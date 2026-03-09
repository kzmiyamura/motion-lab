import type { CapacitorConfig } from '@capacitor/core';

/**
 * Capacitor 設定
 *
 * セットアップ手順:
 *   npm install @capacitor/core @capacitor/cli @capacitor/ios
 *   npx cap init
 *   npx cap add ios
 *   npx cap sync
 *   npx cap open ios  → Xcode で開いてビルド
 *
 * iOS バックグラウンドオーディオ:
 *   npx cap add ios 後、ios/App/App/Info.plist に UIBackgroundModes を追加する。
 *   → このリポジトリの ios/App/App/Info.plist テンプレートを参照。
 */
const config: CapacitorConfig = {
  appId: 'com.motionlab.app',
  appName: 'MotionLab',
  webDir: 'dist',

  server: {
    androidScheme: 'https',
  },

  ios: {
    // ステータスバーをアプリの背景色に合わせる
    backgroundColor: '#080814',
    // ノッチ・Dynamic Island 対応
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    // バックグラウンドオーディオは Info.plist の UIBackgroundModes で制御
    // → ios/App/App/Info.plist の <key>UIBackgroundModes</key> を参照
  },
};

export default config;
