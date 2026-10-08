import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { CINDERDECK_CONNECTION_ACCOUNT_PAGES } from "./CinderdeckConnectionAccountPages";
import { useCinderdeckConnectionAuthPrompt } from "./useCinderdeckConnectionAuthPrompt";

export function CinderdeckConnectionSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredCinderdeckConnectionSidebarSignIn />;
}

export function CinderdeckConnectionSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredCinderdeckConnectionSidebarAvatar />;
}

function ConfiguredCinderdeckConnectionSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {CINDERDECK_CONNECTION_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredCinderdeckConnectionSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useCinderdeckConnectionAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to Remote connections</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
