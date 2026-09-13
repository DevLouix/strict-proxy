Pod::Spec.new do |s|
  s.name             = 'strict_proxy_libbox_bridge'
  s.version          = '0.1.0'
  s.summary          = 'Native sing-box libbox bridge for StrictProxy'
  s.homepage         = 'https://strict.local'
  s.license          = { :type => 'GPL-3.0-or-later', :text => 'See the upstream sing-box license.' }
  s.author           = { 'StrictProxy' => 'security@strict.local' }
  s.source           = { :path => '.' }
  s.source_files = 'Classes/**/*'
  s.dependency 'Flutter'
  s.frameworks = 'NetworkExtension'
  s.platform = :ios, '15.0'
  s.vendored_frameworks = 'Frameworks/Libbox.xcframework' if File.exist?('Frameworks/Libbox.xcframework')
  s.static_framework = true
end
