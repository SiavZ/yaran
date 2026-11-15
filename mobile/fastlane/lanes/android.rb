# Android store lanes: Play internal upload and Play track promotion.
#
# Both run the D23 gate first (`check-versions.mjs --play`): no Play upload or promotion
# can happen before the app-signing key is enrolled in Play App Signing.
platform :android do
  private_lane :play_enrollment_gate do
    sh("node", File.join(REPO_ROOT, "tools/release-trains/check-versions.mjs"), "--play")
  end

  desc "Upload the upload-key-signed AAB to the Play internal track (PLAY_AAB_PATH)"
  lane :internal do
    play_enrollment_gate
    upload_to_play_store(
      package_name: Publisher.app_id!,
      track: "internal",
      aab: required_env("PLAY_AAB_PATH"),
      json_key_data: required_env("PLAY_SERVICE_ACCOUNT_JSON"),
      metadata_path: File.join(REPO_ROOT, "fastlane/metadata/android"),
      skip_upload_apk: true,
      release_status: "completed",
      validate_only: ENV["PLAY_VALIDATE_ONLY"] == "true"
    )
  end

  desc "Promote the tag's Play release between tracks (PLAY_VERSION_CODE, PLAY_TRACK_FROM, PLAY_TRACK_TO, PLAY_ROLLOUT)"
  lane :promote do
    play_enrollment_gate
    # Without version_code supply promotes whichever release is active on the source
    # track; with it, supply refuses when that track holds no release with this code.
    version_code = required_env("PLAY_VERSION_CODE")
    UI.user_error!("PLAY_VERSION_CODE #{version_code.inspect} is not a versionCode") unless version_code.match?(/\A[1-9][0-9]*\z/)
    rollout = ENV["PLAY_ROLLOUT"].to_s
    upload_to_play_store(
      package_name: Publisher.app_id!,
      track: ENV["PLAY_TRACK_FROM"].to_s.empty? ? "internal" : ENV["PLAY_TRACK_FROM"],
      track_promote_to: required_env("PLAY_TRACK_TO"),
      version_code: Integer(version_code, 10),
      rollout: rollout.empty? ? nil : rollout,
      json_key_data: required_env("PLAY_SERVICE_ACCOUNT_JSON"),
      skip_upload_aab: true,
      skip_upload_apk: true,
      skip_upload_metadata: true,
      skip_upload_changelogs: true,
      skip_upload_images: true,
      skip_upload_screenshots: true
    )
  end
end
