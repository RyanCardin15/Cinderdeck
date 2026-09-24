<p align="center"><img src="assets/cinderdeck-icon.png" width="128" alt="Cinderdeck" /></p>

# Cinderdeck

**macOS の開発コントロールデッキ。**

Cinderdeck は、プロジェクト、サービス、開発ツールを一か所で管理するネイティブ Mac アプリです。任意のフォルダやリポジトリを stack にまとめ、各サービスの起動コマンドを設定し、アプリ・ターミナル・コーディングエージェントから操作できます。

- TOML でプロジェクト、環境変数、キーチェーン参照、依存関係、起動確認を設定。
- サービスの起動・停止・再起動、ログ・ポート・プロセスの所有者・エージェントの操作履歴を確認。
- Git の状態を確認し、変更の stash または持ち越しを明示してブランチを切り替え。
- `cinderdeck` CLI とローカル MCP サーバーで Codex、Cursor、Claude Code などに接続。
- ローカルのテキストクリップボード履歴に加え、スクリーンショット、画面録画、注釈、OCR、動画編集を利用。

## はじめに

ソースのビルドには **Xcode 26.2 以降**が必要です。アプリは macOS 13 以降に対応しています。`Cinderdeck.xcodeproj` を開き、**Cinderdeck** scheme を選択してください。[ビルドガイド](docs/BUILD.md)も参照できます。

アプリで **⌘⇧H → Stacks → Create stack** を開き、自分のフォルダとコマンドを設定します。既定の設定場所は `~/.config/cinderdeck/stacks/` です。特定のリポジトリ、フレームワーク、言語には依存しません。設定を保存するだけではサービスは起動しません。

```sh
/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck stacks install-cli
cinderdeck stacks status
cinderdeck stacks setup-agents --print
```

Release 版の初回起動では、カスタマイズ版 Snapzy のローカルデータをコピーします。元データは保持し、既存の Cinderdeck データを上書きしません。macOS が新しいアプリへの権限付与を求める場合があります。[移行の詳細](docs/MIGRATION.md)。

Cinderdeck 独自のバージョンは **1.0.0 (200)** から始まります。リリース版は Cinderdeck の署名済み更新フィードから自動的にアップデートされます（Debug ビルドを除く）。Snapzy の Homebrew パッケージやリリースを Cinderdeck の代わりに使用しないでください。

## クレジット

Cinderdeck は [Ryan Cardin](https://github.com/RyanCardin15) が保守する、**[Snapzy](https://github.com/duongductrong/Snapzy) の独立したフォーク**です。原作は **Trong Duong Duc とコントリビューター**によるもので、キャプチャ・録画・編集機能の基盤を提供しています。元の [BSD 3-Clause ライセンス](LICENSE)と[著作権表示](NOTICE)を保持しています。Snapzy の公式リリースではありません。

[English・完全なドキュメント](README.md) · [Stacks](docs/STACKS.md) · [Cinderdeck の不具合報告](https://github.com/RyanCardin15/Cinderdeck/issues)
