//! Categories within the existing searchable command palette.

use super::text_input::TextInput;
use super::{App, PromptState};
use crate::keybindings::{Action, RuntimeBinding};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PaletteCategory {
    Agents,
    Projects,
    Terminals,
    Git,
    View,
    Input,
    Connections,
    Tools,
}

impl PaletteCategory {
    const ROOTS: [Self; 8] = [
        Self::Agents,
        Self::Projects,
        Self::Terminals,
        Self::Git,
        Self::View,
        Self::Input,
        Self::Connections,
        Self::Tools,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Agents => "Agents",
            Self::Projects => "Projects",
            Self::Terminals => "Terminals",
            Self::Git => "Git & files",
            Self::View => "View & appearance",
            Self::Tools => "Tools & configuration",
            Self::Input => "Input & macros",
            Self::Connections => "Connections",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Agents => "Agent actions, tabs, defaults and preferences",
            Self::Projects => "Project actions, worktrees, startup and environment",
            Self::Terminals => "Open, close and arrange terminals",
            Self::Git => "Pull requests, changes, paths and editors",
            Self::View => "Pane visibility, theme, icons and navigation",
            Self::Tools => "Application tools, global environment and config reload",
            Self::Input => "Tab behavior and terminal macros",
            Self::Connections => "GitHub, Tailscale and Yaran Cloud",
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one arm per category listing its palette actions"
    )]
    fn for_action(action: Action) -> Option<Self> {
        match action {
            Action::ChangeDefaultProvider
            | Action::ToggleRandomizedPetNameDefault
            | Action::SessionSettings
            | Action::ToggleAgentAutoReopen
            | Action::NewAgent
            | Action::NewAgentFromPr
            | Action::NewAgentFromWorktree
            | Action::NewStandaloneAgent
            | Action::ForkAgent
            | Action::ChangeAgentProvider
            | Action::NewTab
            | Action::CloseTab
            | Action::StopTab
            | Action::MoveTabLeft
            | Action::MoveTabRight
            | Action::ReconnectAgent
            | Action::DeleteSession
            | Action::DetachAgent
            | Action::RenameSession
            | Action::OpenAgentInfo
            | Action::ForceReconnectAgent
            | Action::RerunStartupCommandOnAgent
            | Action::MoveAgentUp
            | Action::MoveAgentDown
            | Action::MoveAgentTop
            | Action::MoveAgentBottom
            | Action::SortAgents
            | Action::ReadStartupCommandLogs
            | Action::WatchRules => Some(Self::Agents),
            Action::ChangeProjectDefaultProvider
            | Action::ToggleProjectAutoReopenAgents
            | Action::ConfigureStartupCommand
            | Action::ConfigureProjectEnv
            | Action::ChangeProjectBaseBranch
            | Action::ToggleProject
            | Action::ManageProjects
            | Action::ManageWorktrees
            | Action::OpenProjectBrowser
            | Action::CloneProject
            | Action::RefreshProject
            | Action::CheckoutProjectDefaultBranch
            | Action::DeleteProject
            | Action::RemoveProject
            | Action::MoveProjectUp
            | Action::MoveProjectDown
            | Action::PruneOrphanWorktrees => Some(Self::Projects),
            Action::ShowTerminal
            | Action::CycleTerminalLayout
            | Action::CloseTerminal
            | Action::NewTerminal
            | Action::NewProjectTerminal
            | Action::NewStandaloneTerminal
            | Action::MoveTerminalUp
            | Action::MoveTerminalDown
            | Action::MoveTerminalTop
            | Action::MoveTerminalBottom => Some(Self::Terminals),
            Action::CopyPath
            | Action::OpenWorktreeInEditor
            | Action::ChooseWorktreeEditor
            | Action::OpenCurrentPullRequest
            | Action::PullRequests
            | Action::SendDiffComments
            | Action::RecreateWorkingCopy
            | Action::RefreshChanges => Some(Self::Git),
            Action::ChangeTheme
            | Action::ToggleNerdFontIcons
            | Action::ToggleAlwaysShowTabs
            | Action::TogglePrBannerPosition
            | Action::ToggleDiffLineNumbers
            | Action::RemoveGitPane
            | Action::ToggleHumanBoard
            | Action::FilterAgents
            | Action::FocusAgent
            | Action::ToggleSidebar
            | Action::ToggleGitPane
            | Action::ClearStatusLine => Some(Self::View),
            Action::ToggleTabReachesAgent | Action::EditMacros | Action::DebugInput => {
                Some(Self::Input)
            }
            Action::ToggleGithubIntegration
            | Action::RecheckGithub
            | Action::SetTailscaleMode
            | Action::SetCloudMode
            | Action::CloudLogin
            | Action::CloudLogout
            | Action::CloudRotateToken
            | Action::CloudStatus
            | Action::CloudPairPhone
            | Action::StartWebServer
            | Action::StartBackgroundServer
            | Action::StopBackgroundServer
            | Action::ViewServerLog => Some(Self::Connections),
            Action::ConfigureGlobalEnv
            | Action::ReloadConfig
            | Action::ReloadBinary
            | Action::ToggleHelp
            | Action::ForceRedraw
            | Action::KillRunning
            | Action::ShowWelcomeScreen
            | Action::ShowReleaseNotes
            | Action::ResourceMonitor => Some(Self::Tools),
            _ => None,
        }
    }

    pub(crate) fn title(self) -> String {
        format!("Command Palette / {}", self.name())
    }
}

#[derive(Clone, Copy)]
pub(crate) enum PaletteEntry<'a> {
    Command(&'a RuntimeBinding),
    Category(PaletteCategory),
    Back,
}

impl PaletteEntry<'_> {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Command(binding) => binding.palette_name.expect("palette command has a name"),
            Self::Category(category) => category.name(),
            Self::Back => "Back",
        }
    }

    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::Command(binding) => binding.palette_description.unwrap_or_default(),
            Self::Category(category) => category.description(),
            Self::Back => "Return to the palette categories",
        }
    }
}

impl App {
    /// The palette's matches, phrase hits first and the looser ones after
    /// them, with everything the current state cannot run removed.
    ///
    /// Navigation rows and category filtering are added by `palette_entries`.
    pub(crate) fn filtered_palette_commands(
        &self,
        input: &str,
    ) -> Vec<&crate::keybindings::RuntimeBinding> {
        self.bindings
            .filtered_palette(input)
            .into_iter()
            .filter(|binding| self.is_palette_action_available(binding.action))
            .collect()
    }

    pub(crate) fn palette_entries(&self, input: &str) -> Vec<PaletteEntry<'_>> {
        let selected_category = match self.prompt {
            PromptState::Command { category, .. } => category,
            _ => None,
        };
        let searching = !input.trim().is_empty();
        let mut entries: Vec<_> = self
            .filtered_palette_commands(input)
            .into_iter()
            .filter(|binding| {
                let group = PaletteCategory::for_action(binding.action);
                match selected_category {
                    None => searching,
                    Some(group_name) => group == Some(group_name),
                }
            })
            .map(PaletteEntry::Command)
            .collect();
        if selected_category.is_none() {
            let needle = input.trim().to_lowercase();
            for category in PaletteCategory::ROOTS {
                let name = category.name().to_lowercase();
                if name == needle {
                    entries.insert(0, PaletteEntry::Category(category));
                } else if name.contains(&needle) {
                    entries.push(PaletteEntry::Category(category));
                }
            }
        } else {
            entries.push(PaletteEntry::Back);
        }
        entries
    }

    pub(crate) fn navigate_palette_category(&mut self, category: Option<PaletteCategory>) {
        self.prompt = PromptState::Command {
            input: TextInput::new(),
            selected: 0,
            category,
        };
    }

    pub(crate) fn palette_back(&mut self) {
        if matches!(
            self.prompt,
            PromptState::Command {
                category: Some(_),
                ..
            }
        ) {
            self.navigate_palette_category(None);
        } else {
            self.prompt = PromptState::None;
        }
    }

    /// Resolve the same clamped row the picker highlights when availability changes.
    pub(crate) fn palette_entry_at(
        &self,
        input: &str,
        selected: usize,
    ) -> Option<PaletteEntry<'_>> {
        let entries = self.palette_entries(input);
        entries
            .get(selected.min(entries.len().saturating_sub(1)))
            .copied()
    }

    /// Pull a stale `selected` back onto the list as it stands now, so the
    /// stored cursor and the drawn highlight cannot disagree.
    pub(crate) fn clamp_command_palette_selection(&mut self) {
        let count = match &self.prompt {
            PromptState::Command { input, .. } => self.palette_entries(&input.text).len(),
            _ => return,
        };
        if let PromptState::Command { selected, .. } = &mut self.prompt {
            *selected = (*selected).min(count.saturating_sub(1));
        }
    }

    pub(crate) fn set_command_palette_selection(&mut self, index: usize) {
        let count = match &self.prompt {
            PromptState::Command { input, .. } => self.palette_entries(&input.text).len(),
            _ => 0,
        };
        if count == 0 {
            return;
        }
        if let PromptState::Command { selected, .. } = &mut self.prompt {
            *selected = index.min(count.saturating_sub(1));
        }
    }

    pub(crate) fn execute_selected_command_palette(&mut self) {
        let command = if let PromptState::Command {
            input, selected, ..
        } = &self.prompt
        {
            match self.palette_entry_at(&input.text, *selected) {
                Some(PaletteEntry::Category(category)) => {
                    self.navigate_palette_category(Some(category));
                    return;
                }
                Some(PaletteEntry::Back) => {
                    self.palette_back();
                    return;
                }
                Some(PaletteEntry::Command(binding)) => binding
                    .palette_name
                    .expect("the palette lists only bindings that carry a palette name")
                    .to_string(),
                None => input.text.trim().to_string(),
            }
        } else {
            String::new()
        };
        self.prompt = PromptState::None;
        if let Err(e) = self.execute_command(&command) {
            self.set_error(format!("{e:#}"));
        }
    }
}

#[cfg(test)]
#[path = "command_palette_tests.rs"]
mod tests;
