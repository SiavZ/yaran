/// The machine window's native chrome: full-pane overlays, the expiry banner, a toast, covers.
///
/// Every sentence comes from `Messages` (the shared failure table) and every action is a
/// button with a 44-point minimum and spaced so a slip cannot hit its neighbour. Colors come
/// from Phase 14's exported ui-kit color assets, falling back to system colors. The lock and
/// privacy covers hide the web view completely.
///
/// - Main actor. Built in code, no storyboard. Not compiled on this machine (UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/OverlayView
/// └── MachineViewCore/Messages (inferred)
/// External: UIKit
///
/// Used by:
/// MachineView/OverlayView
/// └── MachineView/MachineViewController (inferred)
/// <module-headers:end>
import MachineViewCore
import UIKit

@MainActor
enum Palette {
    // Phase 14 exports the ui-kit tokens into Colors.xcassets; these names are the assumed ones.
    static var background: UIColor { UIColor(named: "yaranBackground") ?? .systemBackground }
    static var foreground: UIColor { UIColor(named: "yaranForeground") ?? .label }
    static var muted: UIColor { UIColor(named: "yaranMuted") ?? .secondarySystemBackground }
    static var primary: UIColor { UIColor(named: "yaranPrimary") ?? .tintColor }
}

/// A full-pane overlay or the top banner: one sentence and its actions.
@MainActor
final class OverlayView: UIView {
    enum Style { case fullPane, banner }

    init(style: Style, message: String, actions: [(String, String)], onAction: @escaping (String) -> Void) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = style == .fullPane ? Palette.background : Palette.muted
        let label = UILabel()
        label.text = message
        label.textColor = Palette.foreground
        label.numberOfLines = 0
        label.textAlignment = style == .fullPane ? .center : .natural
        label.font = .preferredFont(forTextStyle: style == .fullPane ? .title3 : .subheadline)
        label.adjustsFontForContentSizeCategory = true
        let buttons = actions.map { id, title -> UIButton in
            var config: UIButton.Configuration = id == actions.first?.0 ? .filled() : .bordered()
            config.title = title
            config.baseBackgroundColor = id == actions.first?.0 ? Palette.primary : nil
            let b = UIButton(configuration: config, primaryAction: UIAction { _ in onAction(id) })
            b.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
            return b
        }
        let row = UIStackView(arrangedSubviews: buttons)
        row.axis = style == .fullPane ? .vertical : .horizontal
        row.spacing = 16
        let stack = UIStackView(arrangedSubviews: [label, row])
        stack.axis = style == .fullPane ? .vertical : .horizontal
        stack.spacing = 24
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        let guide = safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(greaterThanOrEqualTo: guide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: guide.bottomAnchor, constant: -12),
            stack.centerYAnchor.constraint(equalTo: guide.centerYAnchor),
        ])
        accessibilityViewIsModal = style == .fullPane
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// Button titles for the shared action ids.
    static func title(_ action: String) -> String {
        switch action {
        case "sign_in": return "Sign in"
        case "back_to_machines": return "Back to machines"
        case "retry": return "Retry"
        case "renew": return "Renew"
        case "try_again": return "Try again"
        case "back": return "Back"
        case "unlock": return "Unlock"
        default: return action
        }
    }

    /// An overlay from the shared table's `overlay` section.
    static func overlay(_ key: String, vars: [String: String], style: Style = .fullPane,
                        onAction: @escaping (String) -> Void) -> OverlayView {
        let row = Messages.overlay[key] ?? Messages.Row(message: key, actions: ["back_to_machines"])
        return OverlayView(style: style, message: Messages.fill(row.message, vars),
                           actions: row.actions.map { ($0, title($0)) }, onAction: onAction)
    }
}

/// An opaque cover for App Lock and screen privacy; nothing of the page shows through.
@MainActor
final class CoverView: UIView {
    init() {
        super.init(frame: .zero)
        backgroundColor = Palette.background
        translatesAutoresizingMaskIntoConstraints = false
        accessibilityViewIsModal = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
}

extension UIView {
    /// Pins `child` to all four edges of this view.
    func pin(_ child: UIView) {
        addSubview(child)
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: leadingAnchor), child.trailingAnchor.constraint(equalTo: trailingAnchor),
            child.topAnchor.constraint(equalTo: topAnchor), child.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    /// Shows `text` briefly at the bottom (downloads refused, renderer recovered).
    func toast(_ text: String) {
        let label = PaddedLabel()
        label.text = text
        label.numberOfLines = 0
        label.textColor = Palette.foreground
        label.backgroundColor = Palette.muted
        label.layer.cornerRadius = 8
        label.clipsToBounds = true
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 16),
            label.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
        UIAccessibility.post(notification: .announcement, argument: text)
        UIView.animate(withDuration: 0.3, delay: 4, options: []) { label.alpha = 0 } completion: { _ in label.removeFromSuperview() }
    }
}

final class PaddedLabel: UILabel {
    override func drawText(in rect: CGRect) { super.drawText(in: rect.insetBy(dx: 12, dy: 8)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + 24, height: s.height + 16)
    }
}
