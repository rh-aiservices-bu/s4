# Frontend Setup Guide

This section covers the setup and configuration for PatternFly 6 React frontend development.

## Introduction

Setting up a PatternFly 6 React application requires proper environment preparation and dependency management. This guide focuses on frontend-specific setup requirements for developing with PatternFly 6 components.

## Related Files

- [**Quick Start**](./quick-start.md) - Get started with frontend development
- [**Development Environment**](./development-environment.md) - Frontend tools and configuration
- [**PatternFly Guidelines**](../guidelines/README.md) - Core development principles
- [**Troubleshooting**](../troubleshooting/common-issues.md) - Common frontend issues

## Prerequisites

Before starting any PatternFly React project, ensure the following requirements are met:

### Required Software

#### Node.js & npm

- **Requirement**: Node.js 20+ and npm 9+
- **Verification**: Run `node --version && npm --version`
- **Installation**: Download from [https://nodejs.org/](https://nodejs.org/)

#### Build Tool: Vite

- **Purpose**: Fast frontend build tool with HMR
- **Included**: Automatically installed with project dependencies
- **Configuration**: `vite.config.ts` in frontend directory

### System Requirements

- **Operating System**: Windows, macOS, or Linux
- **Memory**: Minimum 4GB RAM (8GB recommended for development)
- **Storage**: At least 1GB free space for dependencies
- **Network**: Internet connection for package downloads

## PatternFly 6 Dependencies

### Core Packages

```json
{
  "@patternfly/react-core": "^6.0.0",
  "@patternfly/react-table": "^6.0.0",
  "@patternfly/react-icons": "^6.0.0",
  "react": "^18.0.0",
  "react-dom": "^18.0.0"
}
```

### Development Tools

- **Vite**: Build tool and dev server
- **TypeScript**: Type safety
- **ESLint**: Code quality
- **Vitest**: Testing framework

## Next Steps

1. Follow the [Quick Start Guide](./quick-start.md) to start developing
2. Set up your [Development Environment](./development-environment.md)
3. Review [PatternFly Guidelines](../guidelines/README.md) for best practices
4. Learn about [Component Architecture](../guidelines/component-architecture.md)

## Frontend Best Practices

- **Version Management**: Keep all PatternFly packages at the same major version
- **CSS Import**: Always import `@patternfly/react-core/dist/styles/base.css`
- **Type Safety**: Use TypeScript for all components
- **Theme Testing**: Verify both light and dark themes
- **Accessibility**: Test with screen readers and keyboard navigation

## Quick Setup Checklist

- [ ] Node.js 20+ installed
- [ ] npm 9+ available
- [ ] Vite configuration ready
- [ ] PatternFly 6 packages installed
- [ ] Base CSS imported
- [ ] TypeScript configured
- [ ] ESLint rules set up
