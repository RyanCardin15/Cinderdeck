# Generated with a real artifact checksum by the stable release workflow.
cask "cinderdeck" do
  version "1.1.0"
  sha256 "265c0e6220a8b143b38707c36940a3edc239851ad8e8512939b238c5dc898789"
  url "https://github.com/RyanCardin15/Cinderdeck/releases/download/v#{version}/Cinderdeck-v#{version}.dmg"
  name "Cinderdeck"
  desc "Native macOS development control deck for projects, services, and coding agents"
  homepage "https://github.com/RyanCardin15/Cinderdeck"
  depends_on macos: :ventura
  app "Cinderdeck.app"
  zap trash: [
    "~/Library/Application Support/Cinderdeck",
    "~/Library/Preferences/com.ryancardin.cinderdeck.plist",
    "~/Library/Caches/Cinderdeck",
    "~/Library/Logs/Cinderdeck",
  ]
end
