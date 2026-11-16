# Offline boundary test for the Play promotion: tag -> workflow -> lane -> upload_to_play_store.
#
# Derives the tag's versionCode with the real versions.mjs, follows mobile-store-promote.yml's
# own wiring (tag job output -> play step env), then runs the real Fastfile and android lanes
# with every fastlane action recorded instead of called, so no store or network is touched.
# Needs only Ruby's standard library and node; no fastlane gem.
#
# Usage: ruby mobile/fastlane/test/promote_lane_test.rb (run by workflow-policy.yml)
require "open3"
require "yaml"

FASTLANE_DIR = File.expand_path("..", __dir__)
ROOT = File.expand_path("../..", FASTLANE_DIR)
WORKFLOW = File.join(ROOT, ".github/workflows/mobile-store-promote.yml")

class UserError < StandardError; end

module UI
  def self.user_error!(message)
    raise UserError, message
  end
end

module FastlaneCore
  UI = ::UI
end

# Stands in for fastlane's runner: lanes are recorded, actions are recorded, nothing runs.
class LaneProbe
  attr_reader :calls

  def initialize
    @lanes = {}
    @calls = []
    instance_eval(File.read(File.join(FASTLANE_DIR, "Fastfile")), File.join(FASTLANE_DIR, "Fastfile"))
  end

  def platform(name)
    @platform = name
    yield
  end

  def import(path)
    file = File.join(FASTLANE_DIR, path)
    instance_eval(File.read(file), file)
  end

  def desc(_text); end

  def lane(name, &block)
    @lanes[[@platform, name]] = block
  end

  def private_lane(name, &_block)
    define_singleton_method(name) { @calls << [name] }
  end

  def upload_to_play_store(**options)
    @calls << [:upload_to_play_store, options]
  end

  def run(platform, name, env)
    saved = ENV.to_h
    ENV.update(env)
    @lanes.fetch([platform, name]).call
  ensure
    ENV.replace(saved)
  end
end

require File.join(FASTLANE_DIR, "lib/publisher")
# publisher.properties may still hold placeholders; the id itself is not under test.
def Publisher.app_id!
  "dev.test.yaran"
end

$failures = 0
def check(label)
  yield ? puts("ok   #{label}") : ($failures += 1; puts("FAIL #{label}"))
rescue StandardError => e
  $failures += 1
  puts "FAIL #{label} (#{e.class}: #{e.message})"
end

def refused?(probe, env, pattern)
  probe.run(:android, :promote, env)
  false
rescue UserError => e
  e.message.match?(pattern) && probe.calls.none? { |c| c[0] == :upload_to_play_store }
end

tag = "yaran-mobile-v1.0.0"
out, status = Open3.capture2("node", File.join(ROOT, "tools/release-trains/versions.mjs"), tag)
raise "versions.mjs failed for #{tag}" unless status.success?
derived = out[/^version_code=(\d+)$/, 1]

jobs = YAML.safe_load(File.read(WORKFLOW))["jobs"]
tag_step = jobs["tag"]["steps"].find { |s| s["id"] == "v" }
promote_step = jobs["play"]["steps"].find { |s| s["run"].to_s.include?("fastlane android promote") }
env = promote_step["env"].transform_values do |v|
  {
    "${{ needs.tag.outputs.version_code }}" => derived,
    "${{ inputs.from_track }}" => "internal",
    "${{ inputs.track }}" => "production",
    "${{ inputs.rollout_fraction }}" => "",
    "${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}" => "stub-no-network",
  }.fetch(v, v)
end

check("versions.mjs derives #{tag}'s versionCode") { derived == "1000099" }
check("the tag job runs versions.mjs into its outputs") { tag_step["run"].include?("tools/release-trains/versions.mjs \"$TAG\"") }
check("the tag job exposes version_code") { jobs["tag"]["outputs"]["version_code"] == "${{ steps.v.outputs.version_code }}" }
check("the play job depends on the tag job") { Array(jobs["play"]["needs"]).include?("tag") }
check("the play job checks out the requested tag") { jobs["play"]["steps"].any? { |s| s.dig("with", "ref") == "${{ inputs.tag }}" } }
check("the promote step passes the tag's versionCode to the lane") { promote_step["env"]["PLAY_VERSION_CODE"] == "${{ needs.tag.outputs.version_code }}" }

probe = LaneProbe.new
probe.run(:android, :promote, env)
upload = probe.calls.find { |c| c[0] == :upload_to_play_store }&.last || {}
check("the D23 enrollment gate runs before the promotion") { probe.calls.map(&:first) == %i[play_enrollment_gate upload_to_play_store] }
check("upload_to_play_store selects exactly the tag's versionCode") { upload[:version_code] == Integer(derived) }
check("it promotes internal -> production and uploads nothing") do
  upload[:track] == "internal" && upload[:track_promote_to] == "production" &&
    upload[:skip_upload_aab] && upload[:skip_upload_apk] && upload[:skip_upload_metadata]
end

check("a missing versionCode is refused before Play is called") { refused?(LaneProbe.new, env.merge("PLAY_VERSION_CODE" => ""), /PLAY_VERSION_CODE is not set/) }
check("a malformed versionCode is refused before Play is called") { refused?(LaneProbe.new, env.merge("PLAY_VERSION_CODE" => "1.0.0"), /not a versionCode/) }

puts $failures.zero? ? "all passed" : "#{$failures} failed"
exit($failures.zero? ? 0 : 1)
