<p align="center"><img src="assets/cinderdeck-icon.png" width="128" alt="Cinderdeck" /></p>

# Cinderdeck

**Trung tâm điều khiển môi trường phát triển trên macOS.**

Cinderdeck là ứng dụng Mac native để quản lý các dự án, dịch vụ và công cụ phát triển của bạn tại một nơi. Tạo stack từ bất kỳ nhóm thư mục hoặc repository nào, đặt lệnh khởi chạy cho từng dịch vụ rồi điều khiển qua giao diện, terminal hoặc coding agent.

- Cấu hình dự án với TOML, biến môi trường, Keychain, quan hệ phụ thuộc và kiểm tra trạng thái sẵn sàng.
- Khởi động, dừng, khởi động lại; xem log, cổng mạng, tiến trình và hoạt động của agent.
- Xem trạng thái Git và chuyển nhánh với lựa chọn stash hoặc giữ thay đổi rõ ràng.
- Dùng CLI `cinderdeck` và MCP với Codex, Cursor, Claude Code hoặc client khác.
- Lịch sử clipboard văn bản cục bộ, chụp màn hình, quay màn hình, chú thích, OCR và chỉnh sửa video.

## Bắt đầu

Xây dựng từ mã nguồn bằng **Xcode 26.2 trở lên**; ứng dụng hỗ trợ macOS 13 trở lên. Mở `Cinderdeck.xcodeproj`, chọn scheme **Cinderdeck**. Xem [hướng dẫn build](docs/BUILD.md).

Trong ứng dụng, mở **⌘⇧H → Stacks → Create stack** để chọn thư mục và lệnh của bạn. Cấu hình mặc định nằm tại `~/.config/cinderdeck/stacks/`. Không yêu cầu repository, framework hoặc ngôn ngữ cụ thể. Lưu cấu hình không tự khởi động dịch vụ.

```sh
/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck stacks install-cli
cinderdeck stacks status
cinderdeck stacks setup-agents --print
```

Bản Release đầu tiên sẽ sao chép dữ liệu từ bản Snapzy tùy chỉnh, giữ nguyên bản gốc và không ghi đè dữ liệu Cinderdeck hiện có. macOS có thể yêu cầu cấp lại quyền cho ứng dụng mới. [Chi tiết chuyển đổi](docs/MIGRATION.md).

Cinderdeck bắt đầu với phiên bản **1.0.0 (200)**. Các bản phát hành tự động cập nhật qua kênh phát hành đã ký của Cinderdeck (trừ bản Debug). Không dùng gói Homebrew hoặc bản phát hành Snapzy thay cho Cinderdeck.

## Ghi công

Cinderdeck do [Ryan Cardin](https://github.com/RyanCardin15) duy trì và là một **fork độc lập của [Snapzy](https://github.com/duongductrong/Snapzy)**, được tạo bởi **Trong Duong Duc và các cộng tác viên**. Các công cụ chụp, quay và chỉnh sửa bắt nguồn từ Snapzy. Giữ nguyên giấy phép [BSD 3-Clause](LICENSE) và thông tin trong [NOTICE](NOTICE). Đây không phải bản phát hành chính thức của Snapzy.

[English và tài liệu đầy đủ](README.md) · [Stacks](docs/STACKS.md) · [Báo lỗi Cinderdeck](https://github.com/RyanCardin15/Cinderdeck/issues)
