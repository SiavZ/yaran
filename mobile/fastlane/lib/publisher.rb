# Publisher build values for the fastlane lanes (D16): read from mobile/publisher.properties.
#
# Phase 14 owns that file (keys appId, appleTeamId, publisherDomain, ...); nothing here
# invents an identifier. A lane that needs a value fails loudly while the file is
# missing or still holds the repo default, so no store ever sees a placeholder build.
module Publisher
  PROPERTIES = File.expand_path("../../publisher.properties", __dir__)

  def self.values
    return {} unless File.file?(PROPERTIES)

    File.readlines(PROPERTIES, chomp: true).each_with_object({}) do |line, out|
      next if line.strip.empty? || line.lstrip.start_with?("#", "!")

      key, value = line.split("=", 2)
      out[key.strip] = value.to_s.strip
    end
  end

  # The real application id (Android package and iOS bundle id), or a user error.
  def self.app_id!
    id = values["appId"].to_s
    if id.empty? || id.start_with?("com.example.")
      FastlaneCore::UI.user_error!("#{PROPERTIES} has no real appId (#{id.inspect}); Phase 14's publisher config must name the publisher's id before a store lane runs")
    end
    id
  end

  def self.team_id!
    team = values["appleTeamId"].to_s
    FastlaneCore::UI.user_error!("#{PROPERTIES} has an empty appleTeamId; Phase 14's publisher config must name the Apple team before an iOS lane runs") if team.empty?
    team
  end
end
